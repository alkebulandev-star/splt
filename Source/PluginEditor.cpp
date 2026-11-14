#include "PluginEditor.h"

using namespace juce;

namespace Colours_
{
    const Colour bg    = Theme::bg;
    const Colour panel = Theme::panel;
    const Colour text  = Theme::text;
    const Colour dim   = Theme::dim;
    const Colour good  = Theme::good;
    const Colour bad   = Theme::bad;
    const Colour warn  = Theme::warn;
}

static String pct (double v)
{
    return String (v, std::abs (v - std::round (v)) < 0.005 ? 0 : 2) + "%";
}

static void styleLabel (Label& l, bool dim = true)
{
    l.setColour (Label::textColourId, dim ? Colours_::dim : Colours_::text);
    l.setFont (Theme::font (13.5f));
}

static void styleEditor (TextEditor& t, const String& hint = {})
{
    t.setColour (TextEditor::backgroundColourId, Theme::field);
    t.setColour (TextEditor::textColourId, Colours_::text);
    t.setColour (TextEditor::outlineColourId, Theme::line);
    t.setIndents (8, 5);
    t.setFont (Theme::font (14.5f));
    t.setTextToShowWhenEmpty (hint, Colours_::dim.withAlpha (0.6f));
}

//==============================================================================
void StatusBanner::paint (Graphics& g)
{
    const auto problem = proc.splitProblem();
    const bool confirmed = (bool) proc.song()[IDs::splitsConfirmed];
    const bool ready = problem.isEmpty() && confirmed;

    auto all = getLocalBounds();
    auto top = all.removeFromTop (64);
    g.setColour (Theme::bar);
    g.fillRect (top);
    g.setColour (Theme::bg.brighter (0.03f));
    g.fillRect (all);
    g.setColour (Colours::black.withAlpha (0.35f));
    g.fillRect (all.removeFromBottom (1));

    // Status badge
    auto r = top.reduced (22, 0);
    Colour c = ready ? Colours_::good : (problem.isEmpty() ? Colours_::warn : Colours_::bad);
    if (flashTicks > 0 && (flashTicks % 2) == 0)
        c = c.brighter (0.6f);
    const String label = proc.isBouncing() ? "Bouncing" : (ready ? "Confirmed" : (problem.isEmpty() ? "Not locked" : "Incomplete"));
    Theme::badge (g, r.removeFromRight (136).withSizeKeepingCentre (136, 32).toFloat(), c, label);

    const String transport = proc.isRecording() ? "REC" : (proc.isPlaying() ? "PLAY" : "");
    if (transport.isNotEmpty())
    {
        g.setColour (proc.isRecording() ? Colours_::bad : Colours_::good);
        g.setFont (Theme::font (13.0f, true));
        g.drawText (transport, r.removeFromRight (64), Justification::centred);
    }

    g.setColour (Colours_::text);
    g.setFont (Theme::font (31.0f));
    g.drawText ("Split Tracker", r, Justification::centredLeft);

    // What still needs doing, on the strip under the title bar
    String msg;
    if (proc.isBouncing())
        msg = ready ? "Bouncing with locked splits" : "Bouncing with unconfirmed splits: " + (problem.isEmpty() ? String ("lock them first") : problem);
    else if (ready)
        msg = "Splits locked " + SplitTrackerProcessor::formatTime ((int64) proc.song()[IDs::confirmedAt]) + ". OK to bounce.";
    else if (problem.isEmpty())
        msg = "Everything adds up. Lock the splits before you bounce.";
    else
        msg = "Not ready: " + problem;
    // Untagged tracks never block anything, but stems and takes can only be credited to a tagged artist.
    if (const auto tags = proc.tagReminder(); tags.isNotEmpty() && problem.isEmpty() && ! proc.isBouncing())
        msg << "  Reminder: " << tags;

    g.setColour (ready ? Colours_::text.withAlpha (0.85f) : c);
    g.setFont (Theme::font (14.0f));
    g.drawFittedText (msg, all.reduced (22, 0).withTrimmedRight (420), Justification::centredLeft, 1);
}

//==============================================================================
void SplitRing::paint (Graphics& g)
{
    auto cs = proc.contributors();
    auto area = getLocalBounds().toFloat();
    centre = area.getCentre();
    outerR = (jmin (area.getWidth(), area.getHeight()) / 2) / 1.15f - 4.0f;   // leaves room for the glow
    if (outerR < 30.0f) return;
    innerR = outerR * 0.30f;
    const float twoPi = MathConstants<float>::twoPi;

    double writer = 0;
    for (auto c : cs) writer += (double) c[IDs::writerShare];

    // The disc is painted small and scaled up, so neighbouring colours melt into each
    // other and the edge fades into a glow instead of a hard line.
    const int n = 160, pad = 20;
    Image img (Image::ARGB, n, n, true);
    {
        Graphics ig (img);
        const auto box = Rectangle<float> ((float) pad, (float) pad, (float) (n - pad * 2), (float) (n - pad * 2));
        ig.setColour (Colour (0xff3d3d42));               // the part of the song nobody owns yet
        ig.fillEllipse (box);

        segs.clear();
        const double scale = jmax (100.0, writer);
        float a = 0.0f;
        for (int i = 0; i < cs.getNumChildren(); ++i)
        {
            const double share = (double) cs.getChild (i)[IDs::writerShare];
            if (share <= 0.0) continue;
            const float len = (float) (share / scale) * twoPi;
            Path wedge;
            wedge.addPieSegment (box, a, a + len, 0.0f);
            ig.setColour (Theme::person (i).withMultipliedAlpha (selected >= 0 && i != selected ? 0.30f : 1.0f));
            ig.fillPath (wedge);
            segs.push_back ({ a, a + len, i });
            a += len;
        }
    }
    ImageConvolutionKernel blur (9);
    blur.createGaussianBlur (2.2f);
    blur.applyToImage (img, img, img.getBounds());

    const float drawn = outerR * 2.0f * (float) n / (float) (n - pad * 2);
    g.setImageResamplingQuality (Graphics::highResamplingQuality);
    g.setOpacity (0.30f);                                   // soft glow behind the disc
    g.drawImage (img, Rectangle<float> (drawn * 1.13f, drawn * 1.13f).withCentre (centre));
    g.setOpacity (1.0f);
    {
        Graphics::ScopedSaveState clip (g);                 // the disc itself keeps a clean edge
        Path disc;
        disc.addEllipse (Rectangle<float> (outerR * 2.0f, outerR * 2.0f).withCentre (centre));
        g.reduceClipRegion (disc);
        g.drawImage (img, Rectangle<float> (drawn * 1.04f, drawn * 1.04f).withCentre (centre));
    }

    // Soft dark hole
    const auto hole = Rectangle<float> (innerR * 2.9f, innerR * 2.9f).withCentre (centre);
    {
        ColourGradient cg (Colour (0xff1b1b1d), centre.x, centre.y, Colour (0x001b1b1d), centre.x, hole.getY(), true);
        cg.addColour (0.62, Colour (0xf01b1b1d));
        g.setGradientFill (cg);
    }
    g.fillEllipse (hole);

    // Read-out across the disc
    auto sel = cs.getChild (selected);
    const auto number = pct (sel.isValid() ? (double) sel[IDs::writerShare] : writer);
    auto numArea = Rectangle<float> (outerR * 2.2f, outerR * 0.80f).withCentre (centre);
    g.setFont (Theme::light (outerR * 0.66f));
    g.setColour (Colours::black.withAlpha (0.28f));
    g.drawText (number, numArea.translated (0.0f, 2.5f), Justification::centred);
    g.setColour (Colours::white);
    g.drawText (number, numArea, Justification::centred);

    g.setFont (Theme::font (13.0f));
    g.setColour (Colours::white.withAlpha (0.85f));
    g.drawFittedText (sel.isValid() ? sel[IDs::name].toString()
                                    : (cs.getNumChildren() == 0 ? String ("Add people to start") : String ("writer shares")),
                      Rectangle<float> (outerR * 1.6f, 18.0f).withCentre ({ centre.x, centre.y + outerR * 0.36f }).toNearestInt(),
                      Justification::centred, 1);
}

void SplitRing::mouseUp (const MouseEvent& e)
{
    const auto d = e.position - centre;
    const float dist = d.getDistanceFromOrigin();
    int hit = -1;
    if (dist >= innerR * 0.6f && dist <= outerR + 8.0f)
    {
        float ang = std::atan2 (d.x, -d.y);
        if (ang < 0) ang += MathConstants<float>::twoPi;
        for (auto& s : segs)
            if (ang >= s.from && ang < s.to) hit = s.index;
    }
    if (onPick) onPick (hit);
}

//==============================================================================
SplitsPage::SplitsPage (SplitTrackerProcessor& p) : proc (p), ring (p)
{
    for (auto* l : { &songLabel, &isrcLabel, &iswcLabel, &nameL, &legalL, &roleL, &writerL, &masterL, &proL, &ipiL, &pubL, &pubIpiL, &termsL })
    {
        styleLabel (*l);
        addAndMakeVisible (*l);
    }

    styleEditor (title, "Song title");
    styleEditor (isrc, "e.g. GH-XXX-26-00001");
    styleEditor (iswc, "e.g. T-123.456.789-0");
    styleLabel (idL);
    addAndMakeVisible (idL);
    styleEditor (artistId, "ST-XXXX-XXXX, from their Profile on the website");
    addAndMakeVisible (artistId);
    artistId.onReturnKey = [this] { lookUpArtist(); };
    lookupBtn.onClick = [this] { lookUpArtist(); };
    addAndMakeVisible (lookupBtn);
    // Inviting someone who has not signed up yet is planned; the button is here, out of focus, until then.
    inviteBtn.setEnabled (false);
    inviteBtn.setComponentEffect (&blur);
    inviteBtn.setTooltip ("Coming soon: invite someone who has not signed up yet");
    addAndMakeVisible (inviteBtn);

    styleEditor (name, "Name shown on the song");
    styleEditor (legalName, "Real name, as on their ID");
    styleEditor (writer, "0");
    styleEditor (master, "0");
    styleEditor (pro, "GHAMRO, ASCAP, BMI, PRS...");
    styleEditor (ipi, "Leave empty if none");
    styleEditor (publisher, "Self / publisher name");
    styleEditor (publisherIpi, "");
    styleEditor (terms, "e.g. 3 points, flat fee, credit only");

    for (auto* t : { &title, &isrc, &iswc, &name, &legalName, &writer, &master, &pro, &ipi, &publisher, &publisherIpi, &terms })
        addAndMakeVisible (*t);

    writer.setInputRestrictions (6, "0123456789.");
    master.setInputRestrictions (6, "0123456789.");

    for (auto* l : { &ownerLabel, &codeLabel }) { styleLabel (*l); addAndMakeVisible (*l); }
    styleEditor (ownerId, "Owner's Artist ID, ST-XXXX-XXXX");
    styleEditor (songCode, "Empty for a new song. To join one: its code, SG-XXXX-XXXX");
    addAndMakeVisible (ownerId);
    addAndMakeVisible (songCode);
    ownerId.onFocusLost  = [this] { saveCode (IDs::ownerArtistId, ownerId, false); };
    songCode.onFocusLost = [this] { saveCode (IDs::songCode, songCode, true); };
    ownerId.onReturnKey  = ownerId.onFocusLost;
    songCode.onReturnKey = songCode.onFocusLost;

    siteLabel.setFont (Theme::font (12.5f));
    siteLabel.setColour (Label::textColourId, Colours_::dim);
    siteLabel.setMinimumHorizontalScale (0.75f);
    addAndMakeVisible (siteLabel);
    useSiteBtn.onClick  = [this] { proc.useWebsiteSplit(); refresh(); };
    sendMineBtn.onClick = [this] { proc.sendMySplit(); refresh(); };
    addChildComponent (useSiteBtn);
    addChildComponent (sendMineBtn);

    title.onFocusLost = [this] { saveSongField (IDs::title, title); };
    isrc.onFocusLost  = [this] { saveSongField (IDs::isrc, isrc); };
    iswc.onFocusLost  = [this] { saveSongField (IDs::iswc, iswc); };
    title.onReturnKey = title.onFocusLost;
    isrc.onReturnKey  = isrc.onFocusLost;
    iswc.onReturnKey  = iswc.onFocusLost;

    role.addItemList (Config::roles, 1);
    role.setEditableText (true);   // any role not in the list can be typed
    role.setSelectedItemIndex (0);
    addAndMakeVisible (role);

    list.setRowHeight (72);
    list.setColour (ListBox::backgroundColourId, Colours::transparentBlack);
    list.setOutlineThickness (0);
    addAndMakeVisible (list);

    ring.onPick = [this] (int i)
    {
        if (i >= 0 && i != list.getSelectedRow()) list.selectRow (i);
        else { list.deselectAllRows(); clearForm(); setFormOpen (false); }
    };
    addAndMakeVisible (ring);

    addPersonBtn.onClick = [this]
    {
        list.deselectAllRows();
        clearForm();
        setFormOpen (true);
        name.grabKeyboardFocus();
    };
    addAndMakeVisible (addPersonBtn);

    styleLabel (totals, false);
    totals.setFont (Theme::font (14.5f, true));
    regNotice.setFont (Theme::font (12.5f));
    addAndMakeVisible (totals);

    styleLabel (regNotice);
    regNotice.setColour (Label::textColourId, Colours_::warn);
    addAndMakeVisible (regNotice);

    addBtn.onClick     = [this] { addContributor(); };
    updateBtn.onClick  = [this] { updateContributor(); };
    removeBtn.onClick  = [this] { removeContributor(); };
    clearBtn.onClick   = [this] { list.deselectAllRows(); clearForm(); setFormOpen (false); };
    confirmBtn.onClick = [this]
    {
        if (proc.splitsReady()) return;     // already locked
        auto problem = proc.splitProblem();
        if (problem.isNotEmpty())
        {
            AlertWindow::showMessageBoxAsync (MessageBoxIconType::WarningIcon, "Can't lock yet", problem);
            return;
        }
        auto unregistered = proc.unregisteredContributors();
        String msg = "Everyone in the room agrees to these splits?";
        if (! unregistered.isEmpty())
            msg << "\n\nNo IPI/CAE number for: " << unregistered.joinIntoString (", ")
                << ".\nThey can still be confirmed, but should register so they get paid.";

        if (const auto tags = proc.tagReminder(); tags.isNotEmpty())
            msg << "\n\nReminder: " << tags << "\nStems and takes are only credited to an artist when the track is tagged.";

        AlertWindow::showOkCancelBox (MessageBoxIconType::QuestionIcon, "Lock splits", msg,
                                      "Lock", "Cancel", this,
                                      ModalCallbackFunction::create ([this] (int r)
                                      {
                                          if (r == 1) { proc.confirmSplits(); refresh(); }
                                      }));
    };
    registerBtn.onClick = [] { URL (Config::registrationUrl).launchInDefaultBrowser(); };

    for (auto* b : { &addBtn, &updateBtn, &removeBtn, &clearBtn, &confirmBtn, &registerBtn })
        addAndMakeVisible (*b);

    confirmBtn.setColour (TextButton::buttonColourId, Theme::text);
    confirmBtn.setComponentID ("lock");
    addBtn.setColour (TextButton::buttonColourId, Theme::text);
    updateBtn.setColour (TextButton::buttonColourId, Theme::text);
    clearBtn.setButtonText ("Close");
    setFormOpen (false);
    loadSongFields();
    refresh();
}

void SplitsPage::setFormOpen (bool open)
{
    formOpen = open;
    for (auto* c : std::initializer_list<Component*> { &idL, &artistId, &lookupBtn, &inviteBtn, &nameL, &legalL, &legalName, &roleL, &writerL, &masterL, &proL, &ipiL, &pubL, &pubIpiL, &termsL,
                                                       &name, &role, &writer, &master, &pro, &ipi, &publisher, &publisherIpi, &terms, &clearBtn })
        c->setVisible (open);
    ring.setVisible (! open);
    refresh();
}

void SplitsPage::pushLevel (float peak)
{
    const float prev = levels.back();
    levels.erase (levels.begin());
    levels.push_back (jmax (jmin (1.0f, peak), prev * 0.86f));
    repaint (meterArea);
}

void SplitsPage::paint (Graphics& g)
{
    // Green hairlines: one down the middle, one above the bottom strip
    g.setColour (Colours_::good.withAlpha (0.55f));
    g.fillRect (dividerX, mainArea.getY(), 1, bottomArea.getBottom() - mainArea.getY());
    g.fillRect (0, bottomArea.getY(), getWidth(), 1);

    if (formOpen)
    {
        Theme::card (g, formCard.toFloat());
        g.setColour (Colours_::text);
        g.setFont (Theme::font (16.0f, true));
        g.drawText (list.getSelectedRow() >= 0 ? "Edit person" : "Add a person",
                    formCard.reduced (18, 14).removeFromTop (22), Justification::centredLeft);
    }

    if (proc.contributors().getNumChildren() == 0)
    {
        g.setColour (Colours_::dim);
        g.setFont (Theme::font (14.5f));
        g.drawFittedText ("No one on this song yet.", list.getBounds().reduced (10), Justification::centred, 1);
    }

    // Level line: the audio passing through the master right now
    auto m = meterArea.toFloat();
    const float base = m.getBottom() - 6.0f, h = m.getHeight() - 12.0f;
    Path trace;
    for (size_t i = 0; i < levels.size(); ++i)
    {
        const float x = m.getX() + m.getWidth() * (float) i / (float) (levels.size() - 1);
        const float y = base - std::sqrt (levels[i]) * h;
        if (i == 0) trace.startNewSubPath (x, y); else trace.lineTo (x, y);
    }
    g.setColour (Colours_::good.withAlpha (0.18f));
    g.strokePath (trace, PathStrokeType (5.0f, PathStrokeType::curved, PathStrokeType::rounded));
    g.setColour (Colours_::good.withAlpha (0.9f));
    g.strokePath (trace, PathStrokeType (1.6f, PathStrokeType::curved, PathStrokeType::rounded));
}

void SplitsPage::resized()
{
    auto r = getLocalBounds();

    auto top = r.removeFromTop (48).reduced (22, 8);
    songLabel.setBounds (top.removeFromLeft (44));
    title.setBounds (top.removeFromLeft (jmin (300, top.getWidth() / 3)));
    top.removeFromLeft (14);
    isrcLabel.setBounds (top.removeFromLeft (40));
    isrc.setBounds (top.removeFromLeft (190));
    top.removeFromLeft (14);
    iswcLabel.setBounds (top.removeFromLeft (44));
    iswc.setBounds (top);

    auto second = r.removeFromTop (38).reduced (22, 5);
    ownerLabel.setBounds (second.removeFromLeft (44));
    ownerId.setBounds (second.removeFromLeft (jmin (300, second.getWidth() / 3)));
    second.removeFromLeft (14);
    codeLabel.setBounds (second.removeFromLeft (72));
    songCode.setBounds (second);

    bottomArea = r.removeFromBottom (120);
    mainArea = r;
    dividerX = r.getX() + roundToInt ((float) r.getWidth() * 0.52f);

    // Left: the disc (or the form while adding / editing someone)
    auto left = r.withRight (dividerX);
    ring.setBounds (left.reduced (10));
    formCard = left.reduced (22, 12);

    auto form = formCard.reduced (18, 14);
    form.removeFromTop (32);
    auto btns = form.removeFromBottom (36);
    auto row = [&form] { auto x = form.removeFromTop (25); form.removeFromTop (3); return x; };
    auto pair = [] (Rectangle<int> x, Label& l, Component& c) { l.setBounds (x.removeFromLeft (104)); c.setBounds (x); };
    {
        auto idRow = row();
        lookupBtn.setBounds (idRow.removeFromRight (84));
        idRow.removeFromRight (6);
        pair (idRow, idL, artistId);
    }
    pair (row(), nameL, name);
    pair (row(), legalL, legalName);
    pair (row(), roleL, role);
    pair (row(), writerL, writer);
    pair (row(), masterL, master);
    pair (row(), proL, pro);
    pair (row(), ipiL, ipi);
    pair (row(), pubL, publisher);
    pair (row(), pubIpiL, publisherIpi);
    pair (row(), termsL, terms);
    clearBtn.setBounds (btns.removeFromRight (96));
    btns.removeFromRight (8);
    addBtn.setBounds (btns.removeFromLeft (150));
    updateBtn.setBounds (addBtn.getBounds());
    btns.removeFromLeft (8);
    removeBtn.setBounds (btns.removeFromLeft (110));
    btns.removeFromLeft (8);
    inviteBtn.setBounds (btns.removeFromLeft (jmin (124, btns.getWidth())));

    // Right: the people
    auto right = r.withLeft (dividerX + 1).reduced (20, 10);
    addPersonBtn.setBounds (right.removeFromBottom (34).removeFromLeft (170).withTrimmedTop (4));
    list.setBounds (right);

    // Bottom left: totals and the level line. Bottom right: the lock button.
    auto bl = bottomArea.withRight (dividerX).reduced (22, 12);
    auto info = bl.removeFromTop (22);
    totals.setBounds (info);
    auto reg = bl.removeFromTop (22);
    registerBtn.setBounds (reg.removeFromRight (128).withSizeKeepingCentre (128, 22));
    regNotice.setBounds (reg);
    auto site = bl.removeFromTop (24);
    sendMineBtn.setBounds (site.removeFromRight (96).reduced (0, 1));
    site.removeFromRight (6);
    useSiteBtn.setBounds (site.removeFromRight (118).reduced (0, 1));
    siteLabel.setBounds (site);
    meterArea = bl;

    confirmBtn.setBounds (bottomArea.withLeft (dividerX + 1).reduced (24, 0).withSizeKeepingCentre (jmin (360, bottomArea.getRight() - dividerX - 48), 54));
}

void SplitsPage::refresh()
{
    double w = 0, m = 0;
    for (auto c : proc.contributors())
    {
        w += (double) c[IDs::writerShare];
        m += (double) c[IDs::masterShare];
    }
    auto ok = [] (double v) { return std::abs (v - 100.0) <= 0.01; };
    totals.setText ("Writer / publishing " + pct (w) + "      Master " + pct (m), dontSendNotification);
    totals.setColour (Label::textColourId, ok (w) && ok (m) ? Colours_::good : Colours_::bad);

    const bool locked = proc.splitProblem().isEmpty() && (bool) proc.song()[IDs::splitsConfirmed];
    confirmBtn.setButtonText (locked ? "Locked" : "Lock splits");
    confirmBtn.setComponentID (locked ? "tick" : "lock");
    confirmBtn.setColour (TextButton::buttonColourId, locked ? Theme::panelHi : Theme::text);

    auto unregistered = proc.unregisteredContributors();
    regNotice.setText (unregistered.isEmpty() ? String()
                                              : "No IPI/CAE number: " + unregistered.joinIntoString (", "),
                       dontSendNotification);
    registerBtn.setVisible (! unregistered.isEmpty());

    // The website's side of this song, and what to do when both sides changed the split.
    const bool conflict = proc.hasSiteConflict();
    const bool elsewhere = proc.splitManagedElsewhere();
    siteLabel.setText (conflict ? String ("The split was also changed on the website. Which one should stand?") : proc.siteSummary(), dontSendNotification);
    siteLabel.setColour (Label::textColourId, conflict ? Colours_::warn : Colours_::dim);
    useSiteBtn.setVisible (conflict);
    sendMineBtn.setVisible (conflict);
    // A project that only feeds someone else's song shows the split but cannot change it.
    for (auto* b : { &addPersonBtn, &addBtn, &updateBtn, &removeBtn, &confirmBtn })
        b->setEnabled (! elsewhere);

    // Song details that arrive from the website (its code, its owner, its title) appear without retyping.
    // Only when the stored value itself changes (a sync brought something new): text someone is in the
    // middle of entering, by keyboard or through an accessibility tool, is never replaced.
    auto follow = [this] (TextEditor& t, const Identifier& id)
    {
        const auto v = proc.song()[id].toString();
        auto& seen = followed[id.toString()];
        if (seen == v) return;
        seen = v;
        if (! t.hasKeyboardFocus (true) && t.getText().trim() != v) t.setText (v, false);
    };
    follow (title, IDs::title);
    follow (ownerId, IDs::ownerArtistId);
    follow (songCode, IDs::songCode);

    const bool hasSel = list.getSelectedRow() >= 0;
    addBtn.setVisible (formOpen && ! hasSel);
    updateBtn.setVisible (formOpen && hasSel);
    removeBtn.setVisible (formOpen && hasSel);
    updateBtn.setButtonText ("Save");
    list.updateContent();
    list.repaint();
    ring.selected = list.getSelectedRow();
    ring.repaint();
    repaint();
}

int SplitsPage::getNumRows() { return proc.contributors().getNumChildren(); }

void SplitsPage::paintListBoxItem (int row, Graphics& g, int w, int h, bool selected)
{
    auto c = proc.contributors().getChild (row);
    if (! c.isValid()) return;

    const auto col = Theme::person (row);
    auto r = Rectangle<float> (0.0f, 0.0f, (float) w, (float) h).reduced (2.0f, 5.0f);
    Theme::pill (g, r, selected, col);

    auto inner = r.reduced (16.0f, 0.0f);
    Theme::avatar (g, inner.removeFromLeft (46.0f).withSizeKeepingCentre (42.0f, 42.0f), col, c[IDs::name].toString());
    inner.removeFromLeft (14.0f);
    inner.removeFromRight (8.0f);

    const double ws = (double) c[IDs::writerShare], ms = (double) c[IDs::masterShare];
    const bool creditOnly = ws <= 0.0 && ms <= 0.0;
    const bool needsIpi = ws > 0.0 && c[IDs::ipi].toString().isEmpty();   // only writers need an IPI

    // Share: big thin numerals with a fine underline (amber when a writer has no IPI)
    auto share = inner.removeFromRight (126.0f);
    const String shareText = creditOnly ? String ("Credit") : pct (ws);
    g.setColour (creditOnly ? Colours_::dim : Colours_::text);
    g.setFont (Theme::light (creditOnly ? 23.0f : 40.0f));
    g.drawText (shareText, share.withTrimmedBottom (4.0f), Justification::centredRight);
    const float tw = jmin (share.getWidth(), GlyphArrangement::getStringWidth (g.getCurrentFont(), shareText));
    g.setColour (needsIpi ? Colours_::warn : Colours::white.withAlpha (0.28f));
    g.fillRect (Rectangle<float> (tw * 0.74f, 1.6f).withCentre ({ share.getRight() - tw / 2, r.getBottom() - 9.0f }));
    inner.removeFromRight (10.0f);

    // Name, and under it a small chip with role, master share and deal
    g.setColour (Colours_::text);
    g.setFont (Theme::font (16.0f));
    g.drawFittedText (c[IDs::name].toString(), inner.withHeight (22.0f).withY (r.getY() + 10.0f).toNearestInt(), Justification::centredLeft, 1);

    String sub = c[IDs::role].toString();
    if (ms > 0.0) sub << "  -  master " << pct (ms);
    if (c[IDs::terms].toString().isNotEmpty()) sub << "  -  " << c[IDs::terms].toString();
    const bool needsLegal = ! creditOnly && c[IDs::legalName].toString().trim().isEmpty();
    if (needsLegal) sub << "  -  add legal name";
    const bool needsId = ! creditOnly && ArtistId::normalise (c[IDs::artistId].toString()).isEmpty();
    if (needsId) sub << "  -  not signed up: add Artist ID";
    if (needsIpi) sub << "  -  no IPI";
    g.setFont (Theme::font (11.5f));
    const float cw = jmin (inner.getWidth(), GlyphArrangement::getStringWidth (g.getCurrentFont(), sub) + 14.0f);
    auto chip = Rectangle<float> (inner.getX(), r.getY() + 34.0f, cw, 18.0f);
    g.setColour (Colours::white.withAlpha (0.07f));
    g.fillRoundedRectangle (chip, 5.0f);
    g.setColour (needsIpi || needsLegal || needsId ? Colours_::warn : Colours_::dim);
    g.drawFittedText (sub, chip.reduced (7.0f, 0.0f).toNearestInt(), Justification::centredLeft, 1);
}

void SplitsPage::selectedRowsChanged (int row)
{
    auto c = proc.contributors().getChild (row);
    if (c.isValid())
    {
        artistId.setText (c[IDs::artistId].toString());
        name.setText (c[IDs::name].toString());
        legalName.setText (c[IDs::legalName].toString());
        role.setText (c[IDs::role].toString(), dontSendNotification);
        writer.setText (c[IDs::writerShare].toString());
        master.setText (c[IDs::masterShare].toString());
        pro.setText (c[IDs::pro].toString());
        ipi.setText (c[IDs::ipi].toString());
        publisher.setText (c[IDs::publisher].toString());
        publisherIpi.setText (c[IDs::publisherIpi].toString());
        terms.setText (c[IDs::terms].toString());
        setFormOpen (true);
    }
    refresh();
}

void SplitsPage::loadSongFields()
{
    auto s = proc.song();
    title.setText (s[IDs::title].toString(), false);
    isrc.setText (s[IDs::isrc].toString(), false);
    iswc.setText (s[IDs::iswc].toString(), false);
    ownerId.setText (s[IDs::ownerArtistId].toString(), false);
    songCode.setText (s[IDs::songCode].toString(), false);
}

/** Owner's Artist ID and the song code: kept only when they are well formed, then sent to the website. */
void SplitsPage::saveCode (const Identifier& id, TextEditor& t, bool isSongCode)
{
    auto s = proc.song();
    const auto typed = t.getText().trim();
    const auto tidy = isSongCode ? ArtistId::normaliseSongCode (typed) : ArtistId::normalise (typed);
    if (typed.isNotEmpty() && tidy.isEmpty())
    {
        t.setText (s[id].toString(), false);
        return AlertWindow::showMessageBoxAsync (MessageBoxIconType::WarningIcon, isSongCode ? "Song code" : "Owner",
            isSongCode ? "That is not a song code. It looks like SG-4MPT-2K7H and is on the song's page on the website."
                       : "That is not an Artist ID. The owner's ID looks like ST-7K2Q-9FXM and is on their Profile on the website.");
    }
    if (s[id].toString() == tidy) return;
    s.setProperty (id, tidy, nullptr);
    t.setText (tidy, false);
    proc.addLog ("SONG", isSongCode ? (tidy.isEmpty() ? String ("Song code cleared") : "Joining the song " + tidy + " on the website")
                                    : (tidy.isEmpty() ? String ("Owner cleared") : "Owner stated as " + tidy));
    proc.requestSyncSoon();
}

void SplitsPage::saveSongField (const Identifier& id, TextEditor& t)
{
    auto s = proc.song();
    const auto v = t.getText().trim();
    if (s[id].toString() != v)
    {
        s.setProperty (id, v, nullptr);
        proc.addLog ("SONG", id.toString().toUpperCase() + " set to \"" + v + "\"");
        proc.requestSyncSoon();
    }
}

String SplitsPage::validateForm()
{
    if (name.getText().trim().isEmpty()) return "Enter the artist name.";
    if (role.getText().trim().isEmpty()) return "Pick or type a role.";
    const double w = writer.getText().getDoubleValue(), m = master.getText().getDoubleValue();
    if (w < 0 || w > 100 || m < 0 || m > 100) return "Shares must be between 0 and 100.";
    return {};
}

void SplitsPage::writeForm (ValueTree c)
{
    // Kept in its tidy form when it is a real ID; otherwise kept as typed so the row shows it needs fixing.
    const auto tidy = ArtistId::normalise (artistId.getText());
    c.setProperty (IDs::artistId, tidy.isNotEmpty() ? tidy : artistId.getText().trim(), nullptr);
    c.setProperty (IDs::name, name.getText().trim(), nullptr);
    c.setProperty (IDs::legalName, legalName.getText().trim(), nullptr);
    c.setProperty (IDs::role, role.getText().trim(), nullptr);
    c.setProperty (IDs::writerShare, writer.getText().getDoubleValue(), nullptr);
    c.setProperty (IDs::masterShare, master.getText().getDoubleValue(), nullptr);
    c.setProperty (IDs::pro, pro.getText().trim(), nullptr);
    c.setProperty (IDs::ipi, ipi.getText().trim(), nullptr);
    c.setProperty (IDs::publisher, publisher.getText().trim(), nullptr);
    c.setProperty (IDs::publisherIpi, publisherIpi.getText().trim(), nullptr);
    c.setProperty (IDs::terms, terms.getText().trim(), nullptr);
}

void SplitsPage::clearForm()
{
    for (auto* t : { &artistId, &name, &legalName, &writer, &master, &pro, &ipi, &publisher, &publisherIpi, &terms })
        t->clear();
    role.setSelectedItemIndex (0);
    refresh();
}

/** Fills the form from the account behind an Artist ID. Shares and deal notes are left for the user. */
void SplitsPage::lookUpArtist()
{
    lookupBtn.setEnabled (false);
    lookupBtn.setButtonText ("...");
    Component::SafePointer<SplitsPage> safe (this);
    proc.lookupArtist (artistId.getText(), [safe] (const CloudSync::Artist& a)
    {
        if (safe == nullptr) return;
        safe->lookupBtn.setEnabled (true);
        safe->lookupBtn.setButtonText ("Look up");
        if (! a.ok)
            return AlertWindow::showMessageBoxAsync (MessageBoxIconType::WarningIcon, "Artist ID", a.message);
        safe->artistId.setText (a.artistId);
        safe->name.setText (a.artistName);
        safe->legalName.setText (a.legalName);
        if (a.role.isNotEmpty()) safe->role.setText (a.role, dontSendNotification);
        safe->pro.setText (a.pro);
        safe->ipi.setText (a.ipi);
        safe->publisher.setText (a.publisher);
        safe->publisherIpi.setText (a.publisherIpi);
    });
}

void SplitsPage::addContributor()
{
    if (auto err = validateForm(); err.isNotEmpty())
        return AlertWindow::showMessageBoxAsync (MessageBoxIconType::WarningIcon, "Check the form", err);

    ValueTree c (IDs::Contributor);
    writeForm (c);
    c.setProperty (IDs::seconds, 0, nullptr);
    c.setProperty (IDs::checkedIn, false, nullptr);
    proc.contributors().appendChild (c, nullptr);
    proc.splitsEdited ("Added " + c[IDs::name].toString() + " (" + c[IDs::role].toString() + ") W"
                       + String ((double) c[IDs::writerShare], 2) + "% M" + String ((double) c[IDs::masterShare], 2) + "%");

    if (c[IDs::ipi].toString().isEmpty() && (double) c[IDs::writerShare] > 0)
        AlertWindow::showOkCancelBox (MessageBoxIconType::InfoIcon, "Not registered?",
            c[IDs::name].toString() + " has no IPI/CAE number, so publishing royalties can't reach them yet.\n\n"
            "Open " + Config::registrationName + " to get registered?",
            "Open", "Later", this,
            ModalCallbackFunction::create ([] (int r) { if (r == 1) URL (Config::registrationUrl).launchInDefaultBrowser(); }));

    clearForm();
    setFormOpen (false);
}

void SplitsPage::updateContributor()
{
    auto c = proc.contributors().getChild (list.getSelectedRow());
    if (! c.isValid()) return;
    if (auto err = validateForm(); err.isNotEmpty())
        return AlertWindow::showMessageBoxAsync (MessageBoxIconType::WarningIcon, "Check the form", err);

    const auto before = c[IDs::name].toString() + " W" + String ((double) c[IDs::writerShare], 2) + "% M" + String ((double) c[IDs::masterShare], 2) + "%";
    writeForm (c);
    const auto after = c[IDs::name].toString() + " W" + String ((double) c[IDs::writerShare], 2) + "% M" + String ((double) c[IDs::masterShare], 2) + "%";
    proc.splitsEdited ("Updated " + before + " -> " + after);
    refresh();
}

void SplitsPage::removeContributor()
{
    const int row = list.getSelectedRow();
    auto c = proc.contributors().getChild (row);
    if (! c.isValid()) return;
    const auto n = c[IDs::name].toString();
    proc.contributors().removeChild (row, nullptr);
    proc.splitsEdited ("Removed " + n);
    list.deselectAllRows();
    clearForm();
    setFormOpen (false);
}

//==============================================================================
SessionPage::SessionPage (SplitTrackerProcessor& p) : proc (p), board (p)
{
    addAndMakeVisible (who);
    who.onChange = [this] { refresh(); };

    checkBtn.onClick = [this]
    {
        auto c = proc.contributors().getChild (who.getSelectedItemIndex());
        if (! c.isValid()) return;
        const bool in = ! (bool) c[IDs::checkedIn];
        c.setProperty (IDs::checkedIn, in, nullptr);
        proc.addLog ("CHECKIN", c[IDs::name].toString() + (in ? " checked in" : " checked out after "
                     + SplitTrackerProcessor::formatDuration ((int64) c[IDs::seconds]) + " total"));
        refresh();
    };
    addAndMakeVisible (checkBtn);

    popupToggle.setToggleState ((bool) proc.song()[IDs::popupOnBounce], dontSendNotification);
    popupToggle.onClick = [this] { proc.song().setProperty (IDs::popupOnBounce, popupToggle.getToggleState(), nullptr); };
    addAndMakeVisible (popupToggle);

    receiptToggle.setToggleState ((bool) proc.song().getProperty (IDs::openReceiptOnBounce, true), dontSendNotification);
    receiptToggle.onClick = [this] { proc.song().setProperty (IDs::openReceiptOnBounce, receiptToggle.getToggleState(), nullptr); };
    addAndMakeVisible (receiptToggle);

    view.setViewedComponent (&board, false);
    view.setScrollBarsShown (true, false);
    addAndMakeVisible (view);
    refresh();
}

void SessionPage::paint (Graphics& g)
{
    auto s = proc.song();
    const std::pair<String, String> stats[] = {
        { "Time on project", SplitTrackerProcessor::formatDuration ((int64) s[IDs::sessionSeconds]) },
        { "Playback",        SplitTrackerProcessor::formatDuration ((int64) s[IDs::playSeconds]) },
        { "Recording",       SplitTrackerProcessor::formatDuration ((int64) s[IDs::recordSeconds]) },
        { "Bounces",         s[IDs::bounceCount].toString() + "   on " + String (proc.machines().getNumChildren())
                             + (proc.machines().getNumChildren() == 1 ? " computer" : " computers") } };

    auto row = tiles;
    const int w = (row.getWidth() - 36) / 4;
    for (auto& [label, value] : stats)
    {
        auto t = row.removeFromLeft (w).toFloat();
        row.removeFromLeft (12);
        Theme::card (g, t, 16.0f);
        auto in = t.reduced (14.0f, 10.0f);
        g.setColour (Colours_::dim);
        g.setFont (Theme::font (12.0f));
        g.drawText (label, in.removeFromTop (16.0f), Justification::centredLeft);
        g.setColour (Colours_::text);
        g.setFont (Theme::light (25.0f));
        g.drawFittedText (value, in.toNearestInt(), Justification::centredLeft, 1);
    }
}

void SessionPage::resized()
{
    auto r = getLocalBounds().reduced (16, 10);
    tiles = r.removeFromTop (70);
    r.removeFromTop (12);
    auto row = r.removeFromTop (32);
    who.setBounds (row.removeFromLeft (300));
    row.removeFromLeft (8);
    checkBtn.setBounds (row.removeFromLeft (130));
    r.removeFromTop (10);
    receiptToggle.setBounds (r.removeFromBottom (26));
    popupToggle.setBounds (r.removeFromBottom (26));
    r.removeFromBottom (10);
    view.setBounds (r);
    board.setSize (jmax (200, r.getWidth() - 12), board.idealHeight());
}

void SessionPage::refresh()
{
    auto cs = proc.contributors();
    if (cs.getNumChildren() != lastCount)
    {
        lastCount = cs.getNumChildren();
        const int sel = who.getSelectedItemIndex();
        who.clear (dontSendNotification);
        for (int i = 0; i < cs.getNumChildren(); ++i)
            who.addItem (cs.getChild (i)[IDs::name].toString(), i + 1);
        who.setSelectedItemIndex (jlimit (0, jmax (0, lastCount - 1), sel), dontSendNotification);
        who.setTextWhenNothingSelected ("Add people on the Splits tab");
    }

    auto sel = cs.getChild (who.getSelectedItemIndex());
    checkBtn.setEnabled (sel.isValid());
    checkBtn.setButtonText (sel.isValid() && (bool) sel[IDs::checkedIn] ? "Check out" : "Check in");

    if (board.getHeight() != board.idealHeight())
        board.setSize (board.getWidth(), board.idealHeight());
    board.repaint();
    repaint();
}

//==============================================================================
namespace
{
    constexpr int laneH = 54, headH = 30;

    void lane (Graphics& g, Rectangle<float> r, Colour col, const String& avatarName, const String& name, const String& sub,
               double fraction, const String& right, const String& rightSub, bool live)
    {
        r = r.reduced (0.0f, 3.0f);
        Theme::pill (g, r);

        auto in = r.reduced (8.0f, 0.0f);
        Theme::avatar (g, in.removeFromLeft (r.getHeight()).withSizeKeepingCentre (34.0f, 34.0f), col, avatarName);
        in.removeFromLeft (6.0f);

        auto times = in.removeFromRight (210.0f).withTrimmedRight (10.0f);
        g.setColour (Theme::text);
        g.setFont (Theme::light (20.0f));
        g.drawText (right, rightSub.isEmpty() ? times : times.withTrimmedBottom (14.0f), Justification::centredRight);
        if (rightSub.isNotEmpty())
        {
            g.setColour (Theme::dim);
            g.setFont (Theme::font (11.0f));
            g.drawText (rightSub, times.withTop (times.getBottom() - 20.0f).withHeight (14.0f), Justification::centredRight);
        }

        auto names = in.removeFromLeft (jmin (220.0f, in.getWidth() * 0.42f));
        g.setColour (Theme::text);
        g.setFont (Theme::font (14.5f, true));
        g.drawFittedText (name, names.withHeight (20.0f).withY (r.getY() + 6.0f).toNearestInt(), Justification::centredLeft, 1);
        g.setColour (live ? Theme::good : Theme::dim);
        g.setFont (Theme::font (11.5f));
        g.drawFittedText (sub, names.withHeight (16.0f).withY (r.getY() + 25.0f).toNearestInt(), Justification::centredLeft, 1);

        // Time bar
        auto bar = in.reduced (10.0f, 0.0f).withSizeKeepingCentre (jmax (10.0f, in.getWidth() - 20.0f), 8.0f);
        g.setColour (Theme::field);
        g.fillRoundedRectangle (bar, 4.0f);
        if (fraction > 0.0)
        {
            auto fill = bar.withWidth (jmax (8.0f, bar.getWidth() * (float) jlimit (0.0, 1.0, fraction)));
            g.setColour (col.withAlpha (0.25f));
            g.fillRoundedRectangle (fill.expanded (0.0f, 3.0f), 7.0f);
            g.setColour (col);
            g.fillRoundedRectangle (fill, 4.0f);
        }
    }
}

int SessionBoard::idealHeight() const
{
    const int people = proc.contributors().getNumChildren(), tracks = proc.tracks().getNumChildren();
    return headH + jmax (1, people) * laneH + 10 + headH + jmax (1, tracks) * laneH + 8;
}

void SessionBoard::paint (Graphics& g)
{
    auto cs = proc.contributors();
    auto ts = proc.tracks();
    auto r = getLocalBounds().toFloat();

    auto heading = [&] (const String& t)
    {
        g.setColour (Theme::dim);
        g.setFont (Theme::font (12.5f, true));
        g.drawText (t, r.removeFromTop ((float) headH).withTrimmedLeft (6.0f), Justification::centredLeft);
    };
    auto hint = [&] (const String& t)
    {
        g.setColour (Theme::dim);
        g.setFont (Theme::font (13.5f));
        g.drawText (t, r.removeFromTop ((float) laneH).withTrimmedLeft (6.0f), Justification::centredLeft);
    };

    heading ("WHO HAS BEEN ON THIS SONG");
    int64 maxSecs = 1;
    for (auto c : cs) maxSecs = jmax (maxSecs, (int64) c[IDs::seconds]);
    if (cs.getNumChildren() == 0) hint ("Add people on the Splits tab, then check them in when they are in the room.");
    for (int i = 0; i < cs.getNumChildren(); ++i)
    {
        auto c = cs.getChild (i);
        const bool in = (bool) c[IDs::checkedIn];
        lane (g, r.removeFromTop ((float) laneH), Theme::person (i), c[IDs::name].toString(), c[IDs::name].toString(),
              in ? "In the session now" : c[IDs::role].toString(),
              (double) (int64) c[IDs::seconds] / (double) maxSecs,
              SplitTrackerProcessor::formatDuration ((int64) c[IDs::seconds]), {}, in);
    }

    r.removeFromTop (10.0f);
    heading ("TAGGED TRACKS");
    int64 maxTrack = 1;
    for (auto t : ts) maxTrack = jmax (maxTrack, (int64) t[IDs::signalSeconds]);
    if (ts.getNumChildren() == 0) hint ("Put Split Tag on each track and pick who is on it.");
    for (auto t : ts)
    {
        const auto who = t[IDs::person].toString();
        int idx = -1;
        for (int i = 0; i < cs.getNumChildren(); ++i)
            if (cs.getChild (i)[IDs::name].toString() == who) idx = i;
        lane (g, r.removeFromTop ((float) laneH), idx >= 0 ? Theme::person (idx) : Theme::dim,
              who.isEmpty() ? t[IDs::trackName].toString() : who, t[IDs::trackName].toString(),
              who.isEmpty() ? String ("No one set") : who,
              (double) (int64) t[IDs::signalSeconds] / (double) maxTrack,
              SplitTrackerProcessor::formatDuration ((int64) t[IDs::signalSeconds]),
              "recorded " + SplitTrackerProcessor::formatDuration ((int64) t[IDs::recordSeconds])
                  + ((int) t[IDs::takes] > 0 ? "  -  " + String ((int) t[IDs::takes]) + ((int) t[IDs::takes] == 1 ? " take" : " takes") : String()), false);
    }
}

//==============================================================================
LogPage::LogPage (SplitTrackerProcessor& p) : proc (p)
{
    styleLabel (notice);
    notice.setText ("This log is saved inside the DAW project and backed up on this computer. It records sessions, "
                    "bounces, split changes, check-ins, and which computers open the project (computer name, hashed ID).",
                    dontSendNotification);
    notice.setJustificationType (Justification::topLeft);
    addAndMakeVisible (notice);

    styleEditor (view);
    view.setMultiLine (true);
    view.setReadOnly (true);
    view.setScrollbarsShown (true);
    view.setFont (FontOptions (Font::getDefaultMonospacedFontName(), 12.0f, Font::plain));
    addAndMakeVisible (view);

    auto safeName = [this] (const String& suffix)
    {
        auto t = proc.song()[IDs::title].toString().trim();
        return File::createLegalFileName (t.isEmpty() ? "Untitled" : t) + suffix;
    };
    sheetCsv.onClick = [this, safeName] { exportText (safeName (" - split sheet.csv"), [this] { return proc.buildSplitSheetCsv(); }); };
    sheetTxt.onClick = [this, safeName] { exportText (safeName (" - split sheet.txt"), [this] { return proc.buildSplitSheetText(); }); };
    logCsv.onClick   = [this, safeName] { exportText (safeName (" - session log.csv"), [this] { return proc.buildLogCsv(); }); };

    verifyBtn.onClick = [this]
    {
        const int bad = proc.verifyLog();
        if (bad < 0)
            AlertWindow::showMessageBoxAsync (MessageBoxIconType::InfoIcon, "Log intact",
                "All " + String (proc.log().getNumChildren()) + " entries verify.\n\nChain head:\n" + proc.chainHead());
        else
            AlertWindow::showMessageBoxAsync (MessageBoxIconType::WarningIcon, "Log has been altered",
                "The chain breaks at entry " + String (bad + 1) + ". Entries from there on may have been edited or inserted.");
    };
    receiptsBtn.onClick = [this]
    {
        auto f = proc.receiptFolder();
        f.createDirectory();
        f.startAsProcess();
    };

    // Records are backed up on this computer every 30 seconds. If a DAW closed without saving, or the
    // plugin was added again to a project, an earlier session's splits and log can be brought back here.
    restoreBtn.onClick = [this]
    {
        const auto backups = proc.listBackups();
        PopupMenu menu;
        menu.addSectionHeader (backups.empty() ? "No earlier records on this computer" : "Restore the records of...");
        int id = 1;
        for (const auto& b : backups)
            menu.addItem (id++, (b.title.isEmpty() ? String ("Untitled") : b.title)
                                + "  -  " + (b.people.isEmpty() ? String ("no people") : b.people)
                                + "  -  " + String (b.logEntries) + " log entries, last " + SplitTrackerProcessor::formatTime (b.lastTime));
        Component::SafePointer<LogPage> safe (this);
        menu.showMenuAsync (PopupMenu::Options().withTargetComponent (restoreBtn), [safe, backups] (int chosen)
        {
            if (safe == nullptr || chosen <= 0 || chosen > (int) backups.size()) return;
            safe->proc.restoreFromBackup (backups[(size_t) chosen - 1].file);
            safe->lastCount = -1;
            safe->refresh();
        });
    };

    for (auto* b : { &sheetCsv, &sheetTxt, &logCsv, &verifyBtn, &receiptsBtn, &restoreBtn })
        addAndMakeVisible (*b);
    refresh();
}

void LogPage::resized()
{
    auto r = getLocalBounds().reduced (16, 10);
    notice.setBounds (r.removeFromTop (36));
    auto btns = r.removeFromBottom (34);
    const int w = (btns.getWidth() - 40) / 6;
    for (auto* b : { &sheetCsv, &sheetTxt, &logCsv, &verifyBtn, &receiptsBtn, &restoreBtn })
    {
        b->setBounds (btns.removeFromLeft (w));
        btns.removeFromLeft (8);
    }
    r.removeFromBottom (10);
    view.setBounds (r);
}

void LogPage::refresh()
{
    auto l = proc.log();
    if (l.getNumChildren() == lastCount) return;
    lastCount = l.getNumChildren();

    String t;
    for (int i = l.getNumChildren(); --i >= 0;)   // newest first
    {
        auto e = l.getChild (i);
        t << SplitTrackerProcessor::formatTime ((int64) e[IDs::time]) << "  "
          << e[IDs::type].toString().paddedRight (' ', 8) << " " << e[IDs::text].toString() << "\n";
    }
    view.setText (t, false);
}

void LogPage::exportText (const String& defaultName, std::function<String()> make)
{
    chooser = std::make_unique<FileChooser> ("Save", File::getSpecialLocation (File::userDesktopDirectory).getChildFile (defaultName));
    chooser->launchAsync (FileBrowserComponent::saveMode | FileBrowserComponent::canSelectFiles
                            | FileBrowserComponent::warnAboutOverwriting,
                          [this, make] (const FileChooser& fc)
                          {
                              auto f = fc.getResult();
                              if (f == File()) return;
                              if (f.replaceWithText (make()))
                                  proc.addLog ("EXPORT", "Exported " + f.getFileName());
                          });
}

//==============================================================================
EvidencePage::EvidencePage (SplitTrackerProcessor& p) : proc (p)
{
    styleEditor (results);
    results.setMultiLine (true);
    results.setReadOnly (true);
    const auto known = proc.projectFilePath();
    results.setText ((known.isNotEmpty() ? "Project file: " + File (known).getFileName() + " (signed automatically at every bounce)\n\n" : String())
                     + "Drop a file above:\n\n"
                     " - Your EXPORTED BOUNCE: seal it. Its SHA-256 goes into the tamper-evident log, "
                     "so you can later prove that exact file is the original.\n"
                     " - A SONG YOU FOUND (MP3 from WhatsApp, a download, a rip): check whether it is one of this "
                     "song's bounces. The acoustic fingerprint matches even after MP3 or streaming conversion.\n\n"
                     " - YOUR PROJECT FILE (Logic, FL Studio, Ableton, Pro Tools or any other DAW): sign it. "
                     "Its signature goes into the log and onto the next bounce receipt, so you can prove which project the song came from.\n\n"
                     "Every check is recorded in the log.", false);
    addAndMakeVisible (results);

    chooseBtn.onClick = [this]
    {
        chooser = std::make_unique<FileChooser> ("Choose an audio file", File::getSpecialLocation (File::userDesktopDirectory),
                                                 "*.wav;*.aif;*.aiff;*.flac;*.mp3;*.m4a;*.aac;*.ogg");
        chooser->launchAsync (FileBrowserComponent::openMode | FileBrowserComponent::canSelectFiles,
                              [this] (const FileChooser& fc) { if (fc.getResult().existsAsFile()) check (fc.getResult()); });
    };
    addAndMakeVisible (chooseBtn);

    projectBtn.onClick = [this]
    {
        chooser = std::make_unique<FileChooser> ("Choose the project file (Logic, FL Studio, Ableton, Pro Tools...)",
                                                 File::getSpecialLocation (File::userMusicDirectory));
        chooser->launchAsync (FileBrowserComponent::openMode | FileBrowserComponent::canSelectFiles | FileBrowserComponent::canSelectDirectories,
                              [this] (const FileChooser& fc) { if (fc.getResult().exists()) signProject (fc.getResult()); });
    };
    addAndMakeVisible (projectBtn);

    attachBtn.setEnabled (false);
    attachBtn.setColour (TextButton::buttonColourId, Theme::text);
    attachBtn.onClick = [this]
    {
        if (! last.has_value() || last->bestBounce <= 0) return;
        proc.attachFileToBounce (*last);
        results.setText (results.getText() + "\n\nSEALED: " + last->file.getFileName()
                         + " is now recorded as the official export of bounce #" + String (last->bestBounce) + ".", false);
        attachBtn.setEnabled (false);
    };
    addAndMakeVisible (attachBtn);

    accountLabel.setFont (Theme::font (13.5f));
    accountLabel.setColour (Label::textColourId, Colours_::dim);
    accountLabel.setMinimumHorizontalScale (0.8f);
    addAndMakeVisible (accountLabel);
    styleEditor (serverBox, "Server address");
    serverBox.setText (Config::serverUrl, false);
    addChildComponent (serverBox);
    styleEditor (keyBox, "Paste your plugin key (from Profile on the website)");
    keyBox.setPasswordCharacter ((juce_wchar) 0x2022);
    addChildComponent (keyBox);

    linkBtn.onClick = [this]
    {
        const auto problem = proc.linkAccount (serverBox.getText(), keyBox.getText());
        keyBox.clear();
        if (problem.isNotEmpty()) { accountLabel.setVisible (true); accountLabel.setText (problem, dontSendNotification); return; }
        refreshAccount();
        syncBtn.triggerClick();
    };
    addChildComponent (linkBtn);

    syncBtn.onClick = [this]
    {
        accountLabel.setText ("Syncing...", dontSendNotification);
        Component::SafePointer<EvidencePage> safe (this);
        proc.syncNow ([safe] (bool, const String&) { if (safe != nullptr) safe->refreshAccount(); });
    };
    addChildComponent (syncBtn);

    unlinkBtn.onClick = [this] { proc.unlinkAccount(); refreshAccount(); };
    addChildComponent (unlinkBtn);

    // No internet, or no account on this computer: the same records go into one file instead.
    offlineBtn.setTooltip ("No internet here? Save this project's records as one file and send it to the song's owner, who uploads it on the website.");
    offlineBtn.onClick = [this]
    {
        auto name = proc.song()[IDs::title].toString().trim();
        if (name.isEmpty()) name = "Untitled";
        name = File::createLegalFileName (name + " - offline receipt.splitreceipt");
        chooser = std::make_unique<FileChooser> ("Save offline receipt", File::getSpecialLocation (File::userDesktopDirectory).getChildFile (name), "*.splitreceipt");
        chooser->launchAsync (FileBrowserComponent::saveMode | FileBrowserComponent::canSelectFiles | FileBrowserComponent::warnAboutOverwriting,
                              [this] (const FileChooser& fc)
                              {
                                  auto f = fc.getResult();
                                  if (f == File()) return;
                                  f = f.withFileExtension ("splitreceipt");
                                  const auto problem = proc.saveOfflineReceipt (f);
                                  results.setText (problem.isNotEmpty() ? problem
                                      : "OFFLINE RECEIPT SAVED\n" + f.getFullPathName() + "\n\n"
                                        + (proc.tagReminder().isNotEmpty() ? "REMINDER: " + proc.tagReminder() + " Then save the receipt again.\n\n" : String()) +
                                        "What to do with it:\n"
                                        " 1. Send this file to the song's owner: email, WhatsApp, AirDrop or a USB stick all work.\n"
                                        " 2. The owner signs in on the website and opens Overview > \"Upload an offline receipt\".\n"
                                        " 3. They choose this file and pick: register it as a new song, or add it to a song they already have.\n\n"
                                        "The file holds this project's records, its tamper-evident log and its fingerprints. It never holds audio.\n"
                                        "If you are the owner yourself, upload it from any computer that is online.\n"
                                        "When this computer is online again, \"Sync now\" takes over and the receipt is no longer needed.", false);
                              });
    };
    addAndMakeVisible (offlineBtn);
    refreshAccount();
    // Ask the server who this computer is linked to, so the name shows without waiting for a sync.
    Component::SafePointer<EvidencePage> safe (this);
    proc.refreshLinkedAccount ([safe] { if (safe != nullptr) safe->refreshAccount(); });
}

void EvidencePage::refreshAccount()
{
    const auto account = CloudSync::load();
    const bool linked = account.linked();
    serverBox.setVisible (! linked);
    keyBox.setVisible (! linked);
    linkBtn.setVisible (! linked);
    syncBtn.setVisible (linked);
    unlinkBtn.setVisible (linked);
    accountLabel.setVisible (linked);
    if (linked)
    {
        const auto status = proc.syncStatus();
        const auto who = proc.linkedAccount();
        accountLabel.setText ((who.isNotEmpty() ? "Linked as " + who : "Linked to " + URL (account.server).getDomain())
                              + ". Records upload after each bounce, never audio."
                              + (status.isNotEmpty() ? "  " + status : String())
                              + (status.contains ("Could not reach") ? "  Offline? Use \"Save offline receipt\"." : String()), dontSendNotification);
    }
    resized();
}

void EvidencePage::paint (Graphics& g)
{
    auto dz = dropZone.toFloat();
    Theme::card (g, dz, 20.0f, dragOver ? Theme::panelHi.brighter (0.08f) : Theme::panel);
    if (dragOver)
    {
        g.setColour (Colours_::good);
        g.drawRoundedRectangle (dz.reduced (1.0f), 20.0f, 1.6f);
    }

    // Audio fingerprint mark: its lines come from the latest bounce's fingerprint ID
    // (or the log's chain head before the first bounce), so it changes with the song.
    auto mark = dz.removeFromLeft (dz.getHeight()).reduced (14.0f);
    auto bs = proc.bounces();
    String seed = bs.getNumChildren() > 0 ? bs.getChild (bs.getNumChildren() - 1)[IDs::fpId].toString() : String();
    if (seed.isEmpty()) seed = proc.chainHead();
    if (seed.isEmpty()) seed = "0";
    const auto c = mark.getCentre();
    const float r0 = mark.getWidth() * 0.22f, rMax = mark.getWidth() * 0.5f;
    const int n = 72;
    const Colour cols[] = { Theme::person (1), Theme::person (2), Theme::person (4) };
    for (int i = 0; i < n; ++i)
    {
        const int v = CharacterFunctions::getHexDigitValue ((juce_wchar) seed[i % seed.length()]);
        const float len = r0 + (rMax - r0) * (0.25f + 0.75f * (float) jmax (0, v) / 15.0f);
        const float a = (float) i / (float) n * MathConstants<float>::twoPi;
        g.setColour (cols[i % 3].withAlpha (busy ? 1.0f : 0.8f));
        g.drawLine (c.x + std::sin (a) * r0, c.y - std::cos (a) * r0, c.x + std::sin (a) * len, c.y - std::cos (a) * len, 1.6f);
    }

    auto textArea = dz.reduced (12.0f, 18.0f);
    g.setColour (Colours_::text);
    g.setFont (Theme::font (19.0f, true));
    g.drawFittedText (busy ? "Working..." : "Drop a file here", textArea.removeFromTop (30.0f).toNearestInt(), Justification::centredLeft, 1);
    g.setColour (Colours_::dim);
    g.setFont (Theme::font (13.5f));
    g.drawFittedText ("Your exported bounce, a song you found, or the DAW project file itself.\nWAV, AIFF, FLAC, MP3, M4A  -  .logicx, .flp, .als, .ptx and other projects",
                      textArea.toNearestInt(), Justification::topLeft, 3);
}

void EvidencePage::resized()
{
    auto r = getLocalBounds().reduced (16, 10);
    dropZone = r.removeFromTop (130);
    r.removeFromTop (12);
    auto btns = r.removeFromBottom (36);
    chooseBtn.setBounds (btns.removeFromLeft (210));
    btns.removeFromLeft (8);
    projectBtn.setBounds (btns.removeFromLeft (200));
    attachBtn.setBounds (btns.removeFromRight (240));
    r.removeFromBottom (10);

    auto acct = r.removeFromBottom (34);
    r.removeFromBottom (10);
    offlineBtn.setBounds (acct.removeFromRight (190));
    acct.removeFromRight (8);
    if (CloudSync::load().linked())
    {
        unlinkBtn.setBounds (acct.removeFromRight (90));
        acct.removeFromRight (8);
        syncBtn.setBounds (acct.removeFromRight (120));
        acct.removeFromRight (8);
        accountLabel.setBounds (acct);
    }
    else
    {
        linkBtn.setBounds (acct.removeFromRight (120));
        acct.removeFromRight (8);
        serverBox.setBounds (acct.removeFromLeft (230));
        acct.removeFromLeft (8);
        keyBox.setBounds (acct);
    }
    results.setBounds (r);
}

void EvidencePage::filesDropped (const StringArray& files, int, int)
{
    dragOver = false;
    if (! files.isEmpty())
    {
        const File f (files[0]);
        if (f.isDirectory() || Config::dawForProjectFile (f).isNotEmpty()) signProject (f);   // a DAW project, not audio
        else check (f);
    }
    repaint();
}

void EvidencePage::signProject (const File& f)
{
    if (busy) return;
    busy = true;
    attachBtn.setEnabled (false);
    results.setText ("Signing " + f.getFileName() + "...", false);
    repaint();

    Component::SafePointer<EvidencePage> safe (this);
    proc.signProjectFile (f, [safe] (const SplitTrackerProcessor::ProjectSeal& r)
    {
        if (safe == nullptr) return;
        safe->busy = false;
        String t;
        if (! r.ok)
            t << "Could not read " << r.file.getFileName() << ".";
        else
            t << "PROJECT SIGNED\n\n"
              << r.file.getFileName() << (r.daw.isNotEmpty() ? "  (" + r.daw + ")" : String()) << "\n"
              << String (r.files) << (r.files == 1 ? " file, " : " files, ") << File::descriptionOfSizeInBytes (r.bytes) << "\n"
              << "Signature (SHA-256): " << r.sha256 << "\n\n"
              << "This is now in the tamper-evident log and will be printed on the next bounce receipt.\n"
              << "From now on it is signed again automatically at every bounce, as last saved. Save the project before you bounce.";
        safe->results.setText (t, false);
        safe->repaint();
    });
}

void EvidencePage::check (const File& f)
{
    if (busy) return;
    busy = true;
    attachBtn.setEnabled (false);
    results.setText ("Analysing " + f.getFileName() + "...", false);
    repaint();

    Component::SafePointer<EvidencePage> safe (this);
    proc.checkFile (f, [safe] (const SplitTrackerProcessor::FileCheck& r)
    {
        if (safe == nullptr) return;
        auto& self = *safe;
        self.busy = false;
        self.last = r;

        String t;
        t << r.file.getFileName() << "\n"
          << "Size: " << File::descriptionOfSizeInBytes (r.file.getSize()) << "\n"
          << "SHA-256: " << r.sha256 << "\n\n"
          << r.report << "\n";

        bool alreadySealed = false;
        if (r.bestBounce > 0)
        {
            auto b = self.proc.bounces().getChildWithProperty (IDs::num, r.bestBounce);
            alreadySealed = b[IDs::fileSha].toString().isNotEmpty();
            t << "\nBounce #" << r.bestBounce << " was made " << SplitTrackerProcessor::formatTime ((int64) b[IDs::time]) << ".";
            if (alreadySealed && ! r.identical)
                t << "\nThat bounce already has a sealed export (" << b[IDs::fileName].toString()
                  << "), so this is a different file of the same recording, e.g. an MP3 copy.";
            else if (! alreadySealed && r.match.isStrong())
                t << "\nIf this is the file you exported from that bounce, press \"Seal as official export\".";
        }
        self.results.setText (t, false);
        self.attachBtn.setEnabled (r.bestBounce > 0 && r.stem.isEmpty() && ! alreadySealed && ! r.identical && r.match.isStrong());
        self.repaint();
    });
}

//==============================================================================
SplitTrackerEditor::SplitTrackerEditor (SplitTrackerProcessor& p)
    : AudioProcessorEditor (&p), proc (p), banner (p), splits (p), session (p), logPage (p), evidence (p)
{
    LookAndFeel::setDefaultLookAndFeel (&Theme::look());   // so pop-up dialogs match
    setLookAndFeel (&Theme::look());

    addAndMakeVisible (banner);
    for (int i = 0; i < 4; ++i)
    {
        auto& b = tabButtons[i];
        b.setClickingTogglesState (true);
        b.setRadioGroupId (1);
        b.setColour (TextButton::buttonOnColourId, Theme::text);
        b.setColour (TextButton::buttonColourId, Colours::transparentBlack);
        b.onClick = [this, i] { showTab (i); };
        addAndMakeVisible (b);
        addChildComponent (pages[i]);
    }
    showTab (0);

    proc.onBounceStarted = [this]
    {
        banner.flash();
        showTab (0);
        AlertWindow::showMessageBoxAsync (MessageBoxIconType::WarningIcon, "Splits not confirmed",
            "You're bouncing this track but the splits aren't done:\n\n" + proc.splitProblem()
            + (proc.splitProblem().isEmpty() ? String ("Splits haven't been confirmed by the team.") : String())
            + "\n\nFinish and confirm them on the Splits tab.");
    };

    setResizable (true, true);
    setResizeLimits (960, 720, 1600, 1100);
    setSize (1040, 760);
    startTimer (50);
}

SplitTrackerEditor::~SplitTrackerEditor()
{
    proc.onBounceStarted = nullptr;
    setLookAndFeel (nullptr);
}

void SplitTrackerEditor::showTab (int index)
{
    for (int i = 0; i < 4; ++i)
    {
        pages[i]->setVisible (i == index);
        tabButtons[i].setToggleState (i == index, dontSendNotification);
    }
}

void SplitTrackerEditor::paint (Graphics& g)
{
    g.fillAll (Colours_::bg);
}

void SplitTrackerEditor::resized()
{
    auto r = getLocalBounds();
    auto head = r.removeFromTop (104);
    banner.setBounds (head);
    auto tabRow = head.removeFromBottom (40).reduced (22, 6);
    for (int i = 3; i >= 0; --i)
    {
        tabButtons[i].setBounds (tabRow.removeFromRight (92));
        tabRow.removeFromRight (6);
    }
    for (auto* p : pages)
        p->setBounds (r);
}

void SplitTrackerEditor::timerCallback()
{
    splits.pushLevel (proc.takeLivePeak());      // 20 times a second: just the level line
    if (++tickCount % 10 != 0) return;           // twice a second: everything else
    banner.tick();
    session.refresh();
    logPage.refresh();
    splits.refresh();
}
