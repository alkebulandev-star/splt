#pragma once
#include <juce_gui_basics/juce_gui_basics.h>

/** Shared look for Split Tracker and Split Tag: neutral graphite panels, pill-shaped rows,
    thin white type, green hairlines, one colour per person and solid neon green for confirm actions. */
namespace Theme
{
    using juce::Colour;

    inline const Colour bar     { 0xff1d1d1f };   // title bar
    inline const Colour bg      { 0xff29292b };   // window
    inline const Colour panel   { 0xff303033 };
    inline const Colour panelHi { 0xff38383b };   // pill rows
    inline const Colour field   { 0xff1c1c1e };
    inline const Colour line    { 0xff48484d };
    inline const Colour text    { 0xfff6f6f7 };
    inline const Colour dim     { 0xff9c9ca3 };
    inline const Colour good    { 0xff1fe04b };
    inline const Colour bad     { 0xffff5a52 };
    inline const Colour warn    { 0xffffb52e };
    inline const Colour ink     { 0xff161618 };   // dark text on light buttons

    /** One colour per person, the same on every screen. */
    inline Colour person (int index)
    {
        static const Colour p[] = { Colour (0xffecb94b), Colour (0xff27d6c2), Colour (0xff6f7dff), Colour (0xfff2524f),
                                    Colour (0xffb06cf0), Colour (0xff4fc3ff), Colour (0xffff8a3d), Colour (0xff9be15d) };
        return p[(size_t) juce::jmax (0, index) % std::size (p)];
    }

    inline juce::String initials (const juce::String& name)
    {
        juce::StringArray words;
        words.addTokens (name.trim(), " ", {});
        words.removeEmptyStrings();
        juce::String out;
        for (int i = 0; i < words.size() && out.length() < 2; ++i)
            out << words[i].substring (0, 1).toUpperCase();
        return out.isEmpty() ? juce::String ("?") : out;
    }

    /** Thin, clean type. "bold" is a medium weight: nothing in this design is heavy. */
    inline juce::Font font (float height, bool bold = false)
    {
       #if JUCE_MAC
        return juce::Font (juce::FontOptions ("Helvetica Neue", bold ? "Medium" : "Regular", height));
       #else
        return juce::Font (juce::FontOptions (height, bold ? juce::Font::bold : juce::Font::plain));
       #endif
    }

    /** Large numerals. */
    inline juce::Font light (float height)
    {
       #if JUCE_MAC
        return juce::Font (juce::FontOptions ("Helvetica Neue", "Light", height));
       #else
        return juce::Font (juce::FontOptions (height));
       #endif
    }

    /** Flat rounded panel. */
    inline void card (juce::Graphics& g, juce::Rectangle<float> r, float radius = 18.0f, Colour fill = panel)
    {
        g.setColour (fill);
        g.fillRoundedRectangle (r, radius);
        g.setColour (juce::Colours::white.withAlpha (0.05f));
        g.drawRoundedRectangle (r.reduced (0.5f), radius, 1.0f);
    }

    /** Pill-shaped row. */
    inline void pill (juce::Graphics& g, juce::Rectangle<float> r, bool selected = false, Colour outline = good)
    {
        const float radius = r.getHeight() / 2;
        g.setColour (juce::Colours::black.withAlpha (0.22f));
        g.fillRoundedRectangle (r.translated (0.0f, 1.5f), radius);
        g.setColour (selected ? panelHi.brighter (0.08f) : panelHi);
        g.fillRoundedRectangle (r, radius);
        g.setColour (selected ? outline : juce::Colours::white.withAlpha (0.06f));
        g.drawRoundedRectangle (r.reduced (0.75f), radius, selected ? 1.5f : 1.0f);
    }

    /** Dark disc with the person's colour as a ring and their initials. */
    inline void avatar (juce::Graphics& g, juce::Rectangle<float> r, Colour c, const juce::String& name)
    {
        g.setColour (field);
        g.fillEllipse (r);
        g.setColour (c);
        g.drawEllipse (r.reduced (1.5f), 2.6f);
        g.setFont (font (r.getHeight() * 0.36f, true));
        g.drawText (initials (name), r, juce::Justification::centred);
    }

    /** Quiet status chip: dark pill, a small coloured dot, plain text. */
    inline void badge (juce::Graphics& g, juce::Rectangle<float> r, Colour c, const juce::String& label)
    {
        g.setColour (field);
        g.fillRoundedRectangle (r, r.getHeight() / 2);
        g.setColour (c.withAlpha (0.55f));
        g.drawRoundedRectangle (r.reduced (0.5f), r.getHeight() / 2, 1.0f);
        g.setFont (font (13.5f));
        const float tw = juce::GlyphArrangement::getStringWidth (g.getCurrentFont(), label);
        const float x = r.getCentreX() - (tw + 16.0f) / 2;
        g.setColour (c);
        g.fillEllipse (x, r.getCentreY() - 3.5f, 7.0f, 7.0f);
        g.setColour (text);
        g.drawText (label, juce::Rectangle<float> (x + 16.0f, r.getY(), tw + 4.0f, r.getHeight()), juce::Justification::centredLeft);
    }

    /** A small padlock. */
    inline void padlock (juce::Graphics& g, juce::Rectangle<float> r, Colour c)
    {
        const auto body = r.withTrimmedTop (r.getHeight() * 0.42f);
        juce::Path shackle;
        shackle.addCentredArc (r.getCentreX(), body.getY(), r.getWidth() * 0.26f, r.getHeight() * 0.30f, 0.0f,
                               -juce::MathConstants<float>::halfPi, juce::MathConstants<float>::halfPi, true);
        g.setColour (c);
        g.strokePath (shackle, juce::PathStrokeType (r.getWidth() * 0.11f));
        g.fillRoundedRectangle (body.reduced (r.getWidth() * 0.10f, 0.0f), r.getWidth() * 0.12f);
    }

    /** A tick mark. */
    inline void tick (juce::Graphics& g, juce::Rectangle<float> r, Colour c, float thickness = 2.2f)
    {
        juce::Path p;
        p.startNewSubPath (r.getX() + r.getWidth() * 0.18f, r.getY() + r.getHeight() * 0.54f);
        p.lineTo (r.getX() + r.getWidth() * 0.42f, r.getY() + r.getHeight() * 0.76f);
        p.lineTo (r.getX() + r.getWidth() * 0.84f, r.getY() + r.getHeight() * 0.26f);
        g.setColour (c);
        g.strokePath (p, juce::PathStrokeType (thickness, juce::PathStrokeType::curved, juce::PathStrokeType::rounded));
    }

    /** One arc of a donut, with a soft bloom behind it. Angles in radians, 0 = top, clockwise. */
    inline void glowArc (juce::Graphics& g, juce::Point<float> centre, float radius, float thickness,
                         float from, float to, Colour c, bool highlighted = false)
    {
        if (to - from < 0.002f) return;
        juce::Path p;
        p.addCentredArc (centre.x, centre.y, radius, radius, 0.0f, from, to, true);
        const float t = highlighted ? thickness * 1.14f : thickness;
        for (auto [extra, alpha] : { std::pair { 26.0f, 0.045f }, std::pair { 16.0f, 0.07f }, std::pair { 8.0f, 0.12f } })
        {
            g.setColour (c.withAlpha (alpha));
            g.strokePath (p, juce::PathStrokeType (t + extra, juce::PathStrokeType::curved, juce::PathStrokeType::butt));
        }
        g.setGradientFill (juce::ColourGradient (c.brighter (0.35f), centre.x - radius, centre.y - radius,
                                                 c.darker (0.15f), centre.x + radius, centre.y + radius, false));
        g.strokePath (p, juce::PathStrokeType (t, juce::PathStrokeType::curved, juce::PathStrokeType::butt));
    }

    //==========================================================================
    class Look : public juce::LookAndFeel_V4
    {
    public:
        Look()
        {
            using namespace juce;
            setColour (ResizableWindow::backgroundColourId, bg);
            setColour (Label::textColourId, dim);
            setColour (TextEditor::backgroundColourId, field);
            setColour (TextEditor::textColourId, text);
            setColour (TextEditor::outlineColourId, line);
            setColour (TextEditor::focusedOutlineColourId, good.withAlpha (0.8f));
            setColour (TextEditor::highlightColourId, good.withAlpha (0.35f));
            setColour (CaretComponent::caretColourId, good);
            setColour (ComboBox::backgroundColourId, field);
            setColour (ComboBox::textColourId, text);
            setColour (ComboBox::outlineColourId, line);
            setColour (ComboBox::arrowColourId, dim);
            setColour (PopupMenu::backgroundColourId, panel);
            setColour (PopupMenu::textColourId, text);
            setColour (PopupMenu::highlightedBackgroundColourId, panelHi.brighter (0.1f));
            setColour (PopupMenu::highlightedTextColourId, text);
            setColour (TextButton::buttonColourId, panelHi);
            setColour (TextButton::buttonOnColourId, good);
            setColour (TextButton::textColourOffId, text);
            setColour (TextButton::textColourOnId, ink);
            setColour (ToggleButton::textColourId, text);
            setColour (ToggleButton::tickColourId, good);
            setColour (ToggleButton::tickDisabledColourId, dim);
            setColour (ListBox::backgroundColourId, Colours::transparentBlack);
            setColour (ScrollBar::thumbColourId, line.brighter (0.3f));
            setColour (AlertWindow::backgroundColourId, panel);
            setColour (AlertWindow::textColourId, text);
            setColour (AlertWindow::outlineColourId, line);
        }

        void drawButtonBackground (juce::Graphics& g, juce::Button& b, const Colour& colour, bool over, bool down) override
        {
            auto r = b.getLocalBounds().toFloat().reduced (1.0f);
            const float radius = r.getHeight() / 2;
            auto c = colour;
            const bool neon = c.getSaturation() > 0.5f && c.getBrightness() > 0.6f;   // confirm-style buttons glow
            if (! b.isEnabled()) c = c.withMultipliedSaturation (0.3f).withMultipliedAlpha (0.45f);
            else if (down)       c = c.darker (0.2f);
            else if (over)       c = c.brighter (neon ? 0.08f : 0.25f);

            g.setColour (c);
            g.fillRoundedRectangle (r, radius);
            if (! neon)
            {
                g.setColour (juce::Colours::white.withAlpha (0.08f));
                g.drawRoundedRectangle (r.reduced (0.5f), radius, 1.0f);
            }
        }

        juce::Font getTextButtonFont (juce::TextButton&, int h) override
        {
            return font (juce::jlimit (13.0f, 19.0f, (float) h * 0.38f), true);
        }

        void drawButtonText (juce::Graphics& g, juce::TextButton& b, bool, bool) override
        {
            auto bgc = b.findColour (b.getToggleState() ? juce::TextButton::buttonOnColourId : juce::TextButton::buttonColourId);
            const bool lightBg = bgc.getBrightness() > 0.6f;
            g.setFont (getTextButtonFont (b, b.getHeight()));
            g.setColour ((lightBg ? ink : text).withMultipliedAlpha (b.isEnabled() ? 1.0f : 0.5f));
            auto area = b.getLocalBounds().reduced (8, 0);
            const auto id = b.getComponentID();
            if (id == "tick" || id == "lock")     // an icon before the label
            {
                const float tw = juce::GlyphArrangement::getStringWidth (g.getCurrentFont(), b.getButtonText());
                const float th = g.getCurrentFont().getHeight();
                const float x = (float) area.getCentreX() - (tw + th * 1.3f) / 2;
                const auto icon = juce::Rectangle<float> (x, (float) area.getCentreY() - th * 0.42f, th * 0.84f, th * 0.84f);
                if (id == "tick") tick (g, icon, good, th * 0.11f);
                else              padlock (g, icon.reduced (th * 0.06f), lightBg ? ink : text);
                g.setColour ((lightBg ? ink : text).withMultipliedAlpha (b.isEnabled() ? 1.0f : 0.5f));
                g.drawText (b.getButtonText(), juce::Rectangle<float> (x + th * 1.3f, (float) area.getY(), tw + 4.0f, (float) area.getHeight()),
                            juce::Justification::centredLeft);
                return;
            }
            g.drawFittedText (b.getButtonText(), area, juce::Justification::centred, 1);
        }

        void fillTextEditorBackground (juce::Graphics& g, int w, int h, juce::TextEditor& t) override
        {
            g.setColour (t.findColour (juce::TextEditor::backgroundColourId));
            g.fillRoundedRectangle (0.0f, 0.0f, (float) w, (float) h, juce::jmin (10.0f, (float) h / 2));
        }

        void drawTextEditorOutline (juce::Graphics& g, int w, int h, juce::TextEditor& t) override
        {
            const bool focus = t.hasKeyboardFocus (true) && ! t.isReadOnly();
            g.setColour (t.findColour (focus ? juce::TextEditor::focusedOutlineColourId : juce::TextEditor::outlineColourId));
            g.drawRoundedRectangle (0.5f, 0.5f, (float) w - 1.0f, (float) h - 1.0f, juce::jmin (10.0f, (float) h / 2), focus ? 1.5f : 1.0f);
        }

        void drawComboBox (juce::Graphics& g, int w, int h, bool, int, int, int, int, juce::ComboBox& c) override
        {
            auto r = juce::Rectangle<float> (0.5f, 0.5f, (float) w - 1.0f, (float) h - 1.0f);
            g.setColour (c.findColour (juce::ComboBox::backgroundColourId));
            g.fillRoundedRectangle (r, 10.0f);
            g.setColour (c.findColour (juce::ComboBox::outlineColourId));
            g.drawRoundedRectangle (r, 10.0f, 1.0f);
            juce::Path arrow;
            const float cx = (float) w - 16.0f, cy = (float) h / 2;
            arrow.startNewSubPath (cx - 4.5f, cy - 2.0f);
            arrow.lineTo (cx, cy + 2.5f);
            arrow.lineTo (cx + 4.5f, cy - 2.0f);
            g.setColour (c.findColour (juce::ComboBox::arrowColourId));
            g.strokePath (arrow, juce::PathStrokeType (1.6f, juce::PathStrokeType::curved, juce::PathStrokeType::rounded));
        }

        juce::Font getComboBoxFont (juce::ComboBox&) override { return font (14.0f); }
        juce::Font getLabelFont (juce::Label& l) override     { return l.getFont(); }
    };

    /** One shared instance, also used as the default so pop-up dialogs match. */
    inline Look& look()
    {
        static Look l;
        return l;
    }
}
