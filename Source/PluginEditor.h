#pragma once
#include <map>
#include <juce_audio_utils/juce_audio_utils.h>
#include "PluginProcessor.h"
#include "Theme.h"

//==============================================================================
/** Always-visible header: plugin name, what still needs doing, and a status badge
    that is red until splits are complete and green once they are locked. */
class StatusBanner : public juce::Component
{
public:
    explicit StatusBanner (SplitTrackerProcessor& p) : proc (p) {}
    void paint (juce::Graphics&) override;
    void flash() { flashTicks = 12; }
    void tick()  { if (flashTicks > 0) --flashTicks; repaint(); }

private:
    SplitTrackerProcessor& proc;
    int flashTicks = 0;
};

//==============================================================================
/** The split sheet as one picture: a thick outer ring of writer/publishing shares that
    closes at 100%, and a thin inner ring of master shares. Click a slice to select that person. */
class SplitRing : public juce::Component
{
public:
    explicit SplitRing (SplitTrackerProcessor& p) : proc (p) {}
    void paint (juce::Graphics&) override;
    void mouseUp (const juce::MouseEvent&) override;

    std::function<void (int)> onPick;
    int selected = -1;

private:
    struct Seg { float from, to; int index; };
    SplitTrackerProcessor& proc;
    std::vector<Seg> segs;
    juce::Point<float> centre;
    float outerR = 0, innerR = 0;
};

//==============================================================================
class SplitsPage : public juce::Component, private juce::ListBoxModel
{
public:
    explicit SplitsPage (SplitTrackerProcessor&);
    void paint (juce::Graphics&) override;
    void resized() override;
    void refresh();
    void pushLevel (float peak);

private:
    int getNumRows() override;
    void paintListBoxItem (int, juce::Graphics&, int, int, bool) override;
    void selectedRowsChanged (int) override;

    void loadSongFields();
    void saveSongField (const juce::Identifier&, juce::TextEditor&);
    void writeForm (juce::ValueTree c);
    void clearForm();
    juce::String validateForm();
    void addContributor();
    void updateContributor();
    void removeContributor();

    void setFormOpen (bool);

    SplitTrackerProcessor& proc;
    SplitRing ring;
    juce::Rectangle<int> formCard, meterArea, mainArea, bottomArea;
    int dividerX = 0;
    bool formOpen = false;
    std::vector<float> levels = std::vector<float> (160, 0.0f);
    juce::TextButton addPersonBtn { "+ Add person" };
    juce::Label songLabel { {}, "Song" }, isrcLabel { {}, "ISRC" }, iswcLabel { {}, "ISWC" };
    juce::TextEditor title, isrc, iswc;
    // Song details, second row: who owns the song and which song on the website this project feeds.
    juce::Label ownerLabel { {}, "Owner" }, codeLabel { {}, "Song code" }, siteLabel;
    juce::TextEditor ownerId, songCode;
    juce::TextButton useSiteBtn { "Use website's" }, sendMineBtn { "Send mine" };
    void saveCode (const juce::Identifier&, juce::TextEditor&, bool isSongCode);
    std::map<juce::String, juce::String> followed;   // song details as last shown, to spot what a sync changed

    juce::ListBox list { "contributors", this };
    juce::Label totals, regNotice;

    /** Draws a control softly out of focus: for features that are planned but not built yet. */
    struct BlurEffect : juce::ImageEffectFilter
    {
        void applyEffect (juce::Image& source, juce::Graphics& g, float, float alpha) override
        {
            juce::ImageConvolutionKernel kernel (7);
            kernel.createGaussianBlur (2.2f);
            juce::Image soft (juce::Image::ARGB, source.getWidth(), source.getHeight(), true);
            kernel.applyToImage (soft, source, source.getBounds());
            g.setOpacity (alpha * 0.6f);
            g.drawImageAt (soft, 0, 0);
        }
    };
    BlurEffect blur;
    void lookUpArtist();
    juce::Label idL { {}, "Artist ID" };
    juce::TextEditor artistId;
    juce::TextButton lookupBtn { "Look up" }, inviteBtn { "Invite (soon)" };

    juce::Label nameL { {}, "Artist name" }, legalL { {}, "Legal name" }, roleL { {}, "Role" }, writerL { {}, "Writer/Pub %" }, masterL { {}, "Master %" },
                proL { {}, "PRO" }, ipiL { {}, "IPI/CAE #" }, pubL { {}, "Publisher" }, pubIpiL { {}, "Publisher IPI" }, termsL { {}, "Deal / notes" };
    juce::TextEditor name, legalName, writer, master, pro, ipi, publisher, publisherIpi, terms;
    juce::ComboBox role;

    juce::TextButton addBtn { "Add" }, updateBtn { "Update" }, removeBtn { "Remove" }, clearBtn { "New" },
                     confirmBtn { "Lock splits" }, registerBtn { "Get registered" };
};

//==============================================================================
/** Scrolling list of lanes: one per person and one per tagged track, each with a time bar. */
class SessionBoard : public juce::Component
{
public:
    explicit SessionBoard (SplitTrackerProcessor& p) : proc (p) {}
    void paint (juce::Graphics&) override;
    int idealHeight() const;

private:
    SplitTrackerProcessor& proc;
};

class SessionPage : public juce::Component
{
public:
    explicit SessionPage (SplitTrackerProcessor&);
    void paint (juce::Graphics&) override;
    void resized() override;
    void refresh();

private:
    SplitTrackerProcessor& proc;
    SessionBoard board;
    juce::Viewport view;
    juce::Rectangle<int> tiles;
    juce::ComboBox who;
    juce::TextButton checkBtn { "Check in" };
    juce::ToggleButton popupToggle { "Pop-up warning when bouncing with unconfirmed splits" };
    juce::ToggleButton receiptToggle { "Open printable receipt after every bounce" };
    int lastCount = -1;
};

//==============================================================================
class LogPage : public juce::Component
{
public:
    explicit LogPage (SplitTrackerProcessor&);
    void resized() override;
    void refresh();

private:
    void exportText (const juce::String& defaultName, std::function<juce::String()> make);

    SplitTrackerProcessor& proc;
    juce::Label notice;
    juce::TextEditor view;
    juce::TextButton sheetCsv { "Split sheet (CSV)" }, sheetTxt { "Split sheet (text)" },
                     logCsv { "Session log (CSV)" }, verifyBtn { "Verify log" },
                     receiptsBtn { "Receipts folder" }, restoreBtn { "Restore records..." };
    std::unique_ptr<juce::FileChooser> chooser;
    int lastCount = -1;
};

//==============================================================================
/** Drop an exported file to seal it, or any song found "out there" to check
    whether it is one of this project's bounces. */
class EvidencePage : public juce::Component, public juce::FileDragAndDropTarget
{
public:
    explicit EvidencePage (SplitTrackerProcessor&);
    void paint (juce::Graphics&) override;
    void resized() override;
    void visibilityChanged() override { refreshAccount(); }

    bool isInterestedInFileDrag (const juce::StringArray&) override { return true; }
    void fileDragEnter (const juce::StringArray&, int, int) override { dragOver = true; repaint(); }
    void fileDragExit (const juce::StringArray&) override            { dragOver = false; repaint(); }
    void filesDropped (const juce::StringArray& files, int, int) override;

private:
    void check (const juce::File&);

    SplitTrackerProcessor& proc;
    juce::TextEditor results;
    juce::TextButton chooseBtn { "Check an audio file..." }, projectBtn { "Sign project file..." }, attachBtn { "Seal as official export" };
    void signProject (const juce::File&);
    std::unique_ptr<juce::FileChooser> chooser;
    std::optional<SplitTrackerProcessor::FileCheck> last;
    bool dragOver = false, busy = false;
    juce::Rectangle<int> dropZone;

    // Account link: paste a plugin key from the website, then records upload after each bounce.
    void refreshAccount();
    juce::Label accountLabel;
    juce::TextEditor serverBox, keyBox;
    juce::TextButton linkBtn { "Link account" }, syncBtn { "Sync now" }, unlinkBtn { "Unlink" },
                     offlineBtn { "Save offline receipt..." };
};

//==============================================================================
class SplitTrackerEditor : public juce::AudioProcessorEditor, private juce::Timer
{
public:
    explicit SplitTrackerEditor (SplitTrackerProcessor&);
    ~SplitTrackerEditor() override;
    void paint (juce::Graphics&) override;
    void resized() override;

private:
    void timerCallback() override;

    SplitTrackerProcessor& proc;
    StatusBanner banner;
    SplitsPage splits;
    SessionPage session;
    LogPage logPage;
    EvidencePage evidence;
    juce::TextButton tabButtons[4] { juce::TextButton { "Splits" }, juce::TextButton { "Session" },
                                     juce::TextButton { "Evidence" }, juce::TextButton { "Log" } };
    juce::Component* pages[4] { &splits, &session, &evidence, &logPage };
    void showTab (int);
    int tickCount = 0;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (SplitTrackerEditor)
};
