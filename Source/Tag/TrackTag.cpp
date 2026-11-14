// Split Tag: goes on each track. Passes audio through untouched, knows its
// track's name (where the DAW provides it), lets you pick who the track
// belongs to from the master's split sheet, and reports activity to the
// Split Tracker on the master.

#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_cryptography/juce_cryptography.h>
#include "../LiveLink.h"
#include "../RenderCapture.h"
#include "../Theme.h"

using namespace juce;

class TrackTagProcessor : public AudioProcessor, private Timer
{
public:
    TrackTagProcessor()
        : AudioProcessor (BusesProperties()
                            .withInput  ("Input",  AudioChannelSet::stereo(), true)
                            .withOutput ("Output", AudioChannelSet::stereo(), true))
    {
        tagId = Uuid().toString();
        startTimer (1000);
    }

    ~TrackTagProcessor() override
    {
        stopTimer();
        LiveLink::tagFile (tagId).deleteFile();
        LiveLink::stemFile (tagId).deleteFile();
    }

    bool isBusesLayoutSupported (const BusesLayout& l) const override
    {
        auto out = l.getMainOutputChannelSet();
        return (out == AudioChannelSet::mono() || out == AudioChannelSet::stereo())
               && out == l.getMainInputChannelSet();
    }

    void prepareToPlay (double sr, int) override { capture.prepare (sr); }
    void releaseResources() override {}

    void processBlock (AudioBuffer<float>& buffer, MidiBuffer&) override
    {
        // Read-only: the audio is never modified.
        float peak = 0.0f;
        for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
            peak = jmax (peak, buffer.getMagnitude (ch, 0, buffer.getNumSamples()));

        bool playing = false, recording = false;
        if (auto* ph = getPlayHead())
            if (auto pos = ph->getPosition())
            {
                playing = pos->getIsPlaying();
                recording = pos->getIsRecording();
                if (auto t = pos->getTimeInSeconds())
                    songPos.store (*t);
            }

        // During an offline bounce, fingerprint this track's own audio: the stem.
        capture.process (buffer, isNonRealtime());

        lastPeak.store (jmax (lastPeak.load(), peak));
        audioPlaying.store (playing);
        audioRecording.store (recording);
        lastProcessMs.store (Time::getMillisecondCounter());
    }

    void updateTrackProperties (const TrackProperties& p) override
    {
        const ScopedLock sl (lock);
        hostTrackName = p.name;
    }

    //==============================================================================
    String getTrackName()
    {
        const ScopedLock sl (lock);
        return manualTrackName.isNotEmpty() ? manualTrackName
                                            : (hostTrackName.isNotEmpty() ? hostTrackName : String ("Untitled track"));
    }

    String getHostTrackName()            { const ScopedLock sl (lock); return hostTrackName; }
    String getManualTrackName()          { const ScopedLock sl (lock); return manualTrackName; }
    void setManualTrackName (String n)   { const ScopedLock sl (lock); manualTrackName = n.trim(); }
    String getPerson()                   { const ScopedLock sl (lock); return person; }
    void setPerson (String n)            { const ScopedLock sl (lock); person = n; }
    String getMasterId()                 { const ScopedLock sl (lock); return masterId; }
    void setMasterId (String id)         { const ScopedLock sl (lock); masterId = id; }

    bool hasSignal() const   { return signalNow; }
    bool isRecording() const { return audioRecording.load(); }
    bool isPlaying() const   { return audioPlaying.load(); }
    int64 getSignalSeconds() const { return signalSeconds; }
    int64 getRecordSeconds() const { return recordSeconds; }

    //==============================================================================
    const String getName() const override              { return JucePlugin_Name; }
    bool acceptsMidi() const override                  { return false; }
    bool producesMidi() const override                 { return false; }
    bool isMidiEffect() const override                 { return false; }
    double getTailLengthSeconds() const override       { return 0.0; }
    int getNumPrograms() override                      { return 1; }
    int getCurrentProgram() override                   { return 0; }
    void setCurrentProgram (int) override              {}
    const String getProgramName (int) override         { return {}; }
    void changeProgramName (int, const String&) override {}
    bool hasEditor() const override                    { return true; }
    AudioProcessorEditor* createEditor() override;

    void getStateInformation (MemoryBlock& dest) override
    {
        const ScopedLock sl (lock);
        ValueTree v ("TrackTag");
        v.setProperty ("tagId", tagId, nullptr);
        v.setProperty ("masterId", masterId, nullptr);
        v.setProperty ("person", person, nullptr);
        v.setProperty ("manualTrackName", manualTrackName, nullptr);
        v.setProperty ("signalSeconds", signalSeconds, nullptr);
        v.setProperty ("recordSeconds", recordSeconds, nullptr);
        if (auto xml = v.createXml())
            copyXmlToBinary (*xml, dest);
    }

    void setStateInformation (const void* data, int size) override
    {
        if (auto xml = getXmlFromBinary (data, size))
        {
            auto v = ValueTree::fromXml (*xml);
            if (! v.hasType ("TrackTag")) return;

            const ScopedLock sl (lock);
            const auto savedId = v["tagId"].toString();
            if (savedId.isNotEmpty() && savedId != tagId)
            {
                LiveLink::tagFile (tagId).deleteFile();
                tagId = savedId;
            }
            masterId = v["masterId"].toString();
            person = v["person"].toString();
            manualTrackName = v["manualTrackName"].toString();
            signalSeconds = (int64) v["signalSeconds"];
            recordSeconds = (int64) v["recordSeconds"];
        }
    }

private:
    void timerCallback() override
    {
        const bool flowing = Time::getMillisecondCounter() - lastProcessMs.load() < 1500;
        const float peak = lastPeak.exchange (0.0f);
        signalNow = flowing && peak > Decibels::decibelsToGain (-60.0f);

        if (signalNow && audioPlaying.load())   ++signalSeconds;
        if (signalNow && audioRecording.load()) ++recordSeconds;

        // A bounce just ended: save this track's stem fingerprint where the master collects it.
        if (capture.finished())
        {
            auto r = capture.take();
            if (r.seconds >= 1.0 && r.peak > Decibels::decibelsToGain (-60.0f) && ! r.frames.empty())
            {
                const auto data = AcousticFingerprinter::serialise (r.frames, r.secondsPerFrame);
                auto f = LiveLink::stemFile (tagId);
                f.getParentDirectory().createDirectory();
                if (f.replaceWithData (data.getData(), data.getSize()))
                {
                    stemFpId = SHA256 (data).toHexString();
                    stemFrames = (int) r.frames.size();
                    stemSeconds = r.seconds;
                    stemEndMs = Time::currentTimeMillis();
                    ++stemSeq;
                }
            }
        }

        // Auto-link to the only open Split Tracker if not linked yet.
        if (getMasterId().isEmpty())
        {
            auto masters = LiveLink::activeMasters();
            if (masters.size() == 1)
                setMasterId (masters.getReference (0).projectId);
        }

        auto* o = new DynamicObject();
        o->setProperty ("tagId", tagId);
        o->setProperty ("masterId", getMasterId());
        o->setProperty ("trackName", getTrackName());
        o->setProperty ("hostTrackName", getHostTrackName());
        o->setProperty ("person", getPerson());
        o->setProperty ("signal", signalNow);
        o->setProperty ("playing", audioPlaying.load());
        o->setProperty ("recording", audioRecording.load());
        o->setProperty ("signalSeconds", signalSeconds);
        o->setProperty ("recordSeconds", recordSeconds);
        o->setProperty ("songPos", songPos.load());
        o->setProperty ("stemSeq", stemSeq);
        o->setProperty ("stemFpId", stemFpId);
        o->setProperty ("stemFrames", stemFrames);
        o->setProperty ("stemSeconds", stemSeconds);
        o->setProperty ("stemEndMs", stemEndMs);
        o->setProperty ("heartbeat", Time::currentTimeMillis());
        LiveLink::write (LiveLink::tagFile (tagId), var (o));
    }

    CriticalSection lock;
    String tagId, masterId, person, hostTrackName, manualTrackName;
    int64 signalSeconds = 0, recordSeconds = 0;
    bool signalNow = false;

    RenderCapture capture;
    std::atomic<double> songPos { 0.0 };
    String stemFpId;
    int stemSeq = 0, stemFrames = 0;
    double stemSeconds = 0.0;
    int64 stemEndMs = 0;

    std::atomic<float> lastPeak { 0.0f };
    std::atomic<bool> audioPlaying { false }, audioRecording { false };
    std::atomic<uint32> lastProcessMs { 0 };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (TrackTagProcessor)
};

//==============================================================================
class TrackTagEditor : public AudioProcessorEditor, private Timer
{
public:
    explicit TrackTagEditor (TrackTagProcessor& p) : AudioProcessorEditor (&p), proc (p)
    {
        LookAndFeel::setDefaultLookAndFeel (&Theme::look());
        setLookAndFeel (&Theme::look());

        trackName.setColour (TextEditor::backgroundColourId, Colours::transparentBlack);
        trackName.setColour (TextEditor::outlineColourId, Colours::transparentBlack);
        trackName.setColour (TextEditor::focusedOutlineColourId, Theme::line);
        trackName.setFont (Theme::font (30.0f, true));
        trackName.setIndents (0, 2);
        trackName.setText (proc.getManualTrackName(), false);
        trackName.onFocusLost = [this] { proc.setManualTrackName (trackName.getText()); };
        trackName.onReturnKey = trackName.onFocusLost;
        addAndMakeVisible (trackName);

        song.onChange = [this]
        {
            const int i = song.getSelectedItemIndex();
            if (isPositiveAndBelow (i, masters.size()))
                proc.setMasterId (masters.getReference (i).projectId);
            refreshPeople();
        };
        addChildComponent (song);

        setSize (460, 300);
        timerCallback();
        startTimer (1000);
    }

    ~TrackTagEditor() override { setLookAndFeel (nullptr); }

    void paint (Graphics& g) override
    {
        g.fillAll (Theme::bg);
        g.setGradientFill (ColourGradient (Theme::person (2).withAlpha (0.16f), 0.0f, 0.0f, Colours::transparentBlack,
                                           (float) getWidth() * 0.7f, (float) getHeight(), true));
        g.fillAll();

        auto r = getLocalBounds().reduced (18, 0);

        // Header: name and link status
        auto head = r.removeFromTop (54);
        g.setColour (Theme::text);
        g.setFont (Theme::font (19.0f, true));
        g.drawText ("Split Tag", head, Justification::centredLeft);
        const bool linked = currentMaster() != nullptr;
        Theme::badge (g, head.removeFromRight (linked ? 96 : 122).withSizeKeepingCentre (linked ? 96 : 122, 28).toFloat(),
                      linked ? Theme::good : Theme::warn, linked ? "Linked" : "Not linked");

        // Which song this track belongs to (the picker only shows when there is a choice)
        if (! song.isVisible())
        {
            g.setColour (Theme::dim);
            g.setFont (Theme::font (12.5f));
            const auto* m = currentMaster();
            g.drawFittedText (m != nullptr ? "Song: " + (m->title.isNotEmpty() ? m->title : String ("Untitled song"))
                                           : String ("Put Split Tracker on the master track first."),
                              songLine, Justification::centredLeft, 1);
        }

        // People bubbles
        bubbles.clear();
        const auto current = proc.getPerson();
        StringArray shown = people;
        if (current.isNotEmpty() && ! people.contains (current))
            shown.add (current);

        if (shown.isEmpty())
        {
            g.setColour (Theme::dim);
            g.setFont (Theme::font (13.5f));
            g.drawFittedText (linked ? "Add people on the Splits tab of Split Tracker, then tap who is on this track."
                                     : "People from the split sheet will appear here.",
                              peopleArea, Justification::centredLeft, 2);
        }

        const int perRow = jmax (1, peopleArea.getWidth() / 70);
        for (int i = 0; i < shown.size(); ++i)
        {
            const int col = i % perRow, row = i / perRow;
            auto cell = Rectangle<int> (peopleArea.getX() + col * 70, peopleArea.getY() + row * 78, 66, 76);
            if (cell.getBottom() > peopleArea.getBottom() + 4) break;
            const bool onSheet = people.contains (shown[i]);
            const bool sel = shown[i] == current;
            const auto c = (onSheet ? Theme::person (i) : Theme::dim).withMultipliedAlpha (sel || current.isEmpty() ? 1.0f : 0.45f);
            auto circle = cell.removeFromTop (52).withSizeKeepingCentre (46, 46).toFloat();
            if (sel)
            {
                g.setColour (Theme::good.withAlpha (0.25f));
                g.fillEllipse (circle.expanded (7.0f));
                g.setColour (Theme::good);
                g.drawEllipse (circle.expanded (4.0f), 2.0f);
            }
            Theme::avatar (g, circle, c, shown[i]);
            g.setColour (sel ? Theme::text : Theme::dim);
            g.setFont (Theme::font (11.5f, sel));
            g.drawFittedText (shown[i].upToFirstOccurrenceOf (" ", false, false), cell, Justification::centredTop, 1);
            bubbles.add ({ circle.expanded (8.0f).toNearestInt(), shown[i] });
        }

        // Status strip
        auto status = getLocalBounds().removeFromBottom (44).reduced (18, 8).toFloat();
        g.setColour (Theme::panelHi);
        g.fillRoundedRectangle (status, status.getHeight() / 2);
        const bool rec = proc.isRecording() && proc.hasSignal();
        const auto sc = rec ? Theme::bad : (proc.hasSignal() ? Theme::good : Theme::dim);
        auto dot = status.removeFromLeft (status.getHeight()).withSizeKeepingCentre (9.0f, 9.0f);
        g.setColour (sc.withAlpha (0.3f));
        g.fillEllipse (dot.expanded (3.0f));
        g.setColour (sc);
        g.fillEllipse (dot);
        g.setColour (Theme::text);
        g.setFont (Theme::font (13.0f, true));
        g.drawText (rec ? "Recording" : (proc.hasSignal() ? "Signal" : "No signal"), status.removeFromLeft (84.0f), Justification::centredLeft);
        g.setColour (Theme::dim);
        g.setFont (Theme::font (12.5f));
        g.drawText ("played " + duration (proc.getSignalSeconds()) + "    recorded " + duration (proc.getRecordSeconds()),
                    status.withTrimmedRight (14.0f), Justification::centredRight);
    }

    void resized() override
    {
        auto r = getLocalBounds().reduced (18, 0);
        r.removeFromTop (54);
        trackName.setBounds (r.removeFromTop (40));
        songLine = r.removeFromTop (26);
        song.setBounds (songLine.withTrimmedRight (jmax (0, songLine.getWidth() - 280)).reduced (0, 1));
        r.removeFromTop (8);
        r.removeFromBottom (48);
        peopleArea = r;
    }

    void mouseUp (const MouseEvent& e) override
    {
        for (auto& b : bubbles)
            if (b.area.contains (e.getPosition()))
            {
                proc.setPerson (b.name == proc.getPerson() ? String() : b.name);   // tap again to clear
                repaint();
                return;
            }
    }

private:
    struct Bubble { Rectangle<int> area; String name; };

    static String duration (int64 s)
    {
        return String::formatted ("%d:%02d:%02d", (int) (s / 3600), (int) ((s / 60) % 60), (int) (s % 60));
    }

    const LiveLink::MasterInfo* currentMaster() const
    {
        for (auto& m : masters)
            if (m.projectId == proc.getMasterId())
                return &m;
        return nullptr;
    }

    void timerCallback() override
    {
        trackName.setTextToShowWhenEmpty (proc.getHostTrackName().isNotEmpty() ? proc.getHostTrackName()
                                                                                : String ("Track name"),
                                          Theme::text.withAlpha (proc.getHostTrackName().isNotEmpty() ? 1.0f : 0.35f));

        if (! song.isPopupActive())
        {
            masters = LiveLink::activeMasters();
            song.clear (dontSendNotification);
            for (int i = 0; i < masters.size(); ++i)
            {
                const auto& m = masters.getReference (i);
                song.addItem (m.title.isNotEmpty() ? m.title : "Untitled song", i + 1);
                if (m.projectId == proc.getMasterId())
                    song.setSelectedId (i + 1, dontSendNotification);
            }
            song.setTextWhenNothingSelected ("Choose the song");
            song.setVisible (masters.size() > 1);
        }
        refreshPeople();
    }

    void refreshPeople()
    {
        people.clear();
        if (const auto* m = currentMaster())
            people = m->people;
        repaint();
    }

    TrackTagProcessor& proc;
    TextEditor trackName;
    ComboBox song;
    Array<LiveLink::MasterInfo> masters;
    StringArray people;
    Array<Bubble> bubbles;
    Rectangle<int> songLine, peopleArea;
};

AudioProcessorEditor* TrackTagProcessor::createEditor() { return new TrackTagEditor (*this); }

AudioProcessor* JUCE_CALLTYPE createPluginFilter() { return new TrackTagProcessor(); }
