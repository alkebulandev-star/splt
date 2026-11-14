#pragma once
#include <juce_core/juce_core.h>
#include "Config.h"
#include <map>
#if JUCE_MAC || JUCE_LINUX
 #include <sys/stat.h>
#endif

/** Uploads a project's records to the Split Tracker web server, for the account whose
    plugin key was pasted into the Evidence tab.

    What is sent: the split sheet, session and per-track times, takes, bounce and stem
    fingerprint IDs with their fingerprint files, the project-file signature and the log.
    What is never sent: audio, or anything recorded from a microphone.

    All calls here block, so run them off the message thread. */
namespace CloudSync
{
    struct Account
    {
        juce::String server, key;
        bool linked() const { return server.isNotEmpty() && key.isNotEmpty(); }
    };

    inline juce::File accountFile()
    {
        if (auto* custom = std::getenv ("SPLIT_TRACKER_ACCOUNT_FILE"))
            return juce::File (juce::String (juce::CharPointer_UTF8 (custom)));
        return Config::dataFolder().getChildFile ("account.json");
    }

    /** The saved account. SPLIT_TRACKER_SERVER and SPLIT_TRACKER_KEY override it (used by tests). */
    inline Account load()
    {
        Account a;
        const auto v = juce::JSON::parse (accountFile());
        a.server = v.getProperty ("server", {}).toString();
        a.key = v.getProperty ("key", {}).toString();
        if (auto* s = std::getenv ("SPLIT_TRACKER_SERVER")) a.server = juce::String (juce::CharPointer_UTF8 (s));
        if (auto* k = std::getenv ("SPLIT_TRACKER_KEY"))    a.key = juce::String (juce::CharPointer_UTF8 (k));
        return a;
    }

    /** A key is only ever sent over HTTPS, or to this same computer. Returns an error, or an empty string. */
    inline juce::String serverProblem (const juce::String& server)
    {
        const juce::URL u (server);
        const auto host = u.getDomain();
        const bool local = host == "localhost" || host == "127.0.0.1";
        if (! (server.startsWith ("https://") || (server.startsWith ("http://") && local)))
            return "The server address must start with https://";
        if (host.isEmpty()) return "That is not a server address";
        return {};
    }

    inline bool save (const Account& a)
    {
        auto* o = new juce::DynamicObject();
        o->setProperty ("server", a.server);
        o->setProperty ("key", a.key);
        const auto f = accountFile();
        f.getParentDirectory().createDirectory();
        if (! f.replaceWithText (juce::JSON::toString (juce::var (o)))) return false;
       #if JUCE_MAC || JUCE_LINUX
        ::chmod (f.getFullPathName().toRawUTF8(), S_IRUSR | S_IWUSR);   // readable by this user only
       #endif
        return true;
    }

    inline void clear() { accountFile().deleteFile(); }

    struct Response { int status = 0; juce::String body; };

    inline Response request (const juce::String& method, const juce::String& url, const juce::String& key,
                             const juce::MemoryBlock& body, const juce::String& contentType)
    {
        Response r;
        int status = 0;
        const auto opts = juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inPostData)
                              .withExtraHeaders ("Authorization: Bearer " + key + "\r\nContent-Type: " + contentType)
                              .withConnectionTimeoutMs (10000)
                              .withStatusCode (&status)
                              .withHttpRequestCmd (method);
        // A GET carries no body; everything else posts the bytes it was given.
        const auto target = method == "GET" ? juce::URL (url) : juce::URL (url).withPOSTData (body);
        if (auto in = target.createInputStream (opts))
        {
            r.body = in->readEntireStreamAsString();
            r.status = status;
        }
        return r;
    }

    struct Result
    {
        bool ok = false;
        juce::String message, title, accountName, accountId;
        juce::var site;          // the website's side of the song: owner, status, the split as it stands there
        int uploaded = 0;
        bool logIntact = true;
    };

    /** Sends the payload, then uploads whichever fingerprint files the server says it lacks.
        `files` maps a fingerprint ID to its file on this computer. */
    inline Result run (const Account& a, const juce::var& payload, const std::map<juce::String, juce::File>& files)
    {
        Result out;
        if (! a.linked()) { out.message = "Not linked to an account"; return out; }
        if (const auto problem = serverProblem (a.server); problem.isNotEmpty()) { out.message = problem; return out; }
        const auto base = a.server.trimCharactersAtEnd ("/");

        const auto json = juce::JSON::toString (payload, true);
        const auto reply = request ("POST", base + "/api/plugin/sync", a.key,
                                    juce::MemoryBlock (json.toRawUTF8(), json.getNumBytesAsUTF8()), "application/json");
        const auto parsed = juce::JSON::parse (reply.body);
        if (reply.status == 0)   { out.message = "Could not reach " + juce::URL (base).getDomain(); return out; }
        if (reply.status != 200)
        {
            out.message = parsed.getProperty ("error", "The server refused the upload (" + juce::String (reply.status) + ")").toString();
            return out;
        }

        const auto workId = parsed.getProperty ("workId", {}).toString();
        out.title = parsed.getProperty ("title", {}).toString();
        out.logIntact = (bool) parsed.getProperty ("logIntact", true);
        out.accountName = parsed.getProperty ("account", {}).getProperty ("artistName", {}).toString();
        out.accountId = parsed.getProperty ("account", {}).getProperty ("artistId", {}).toString();
        out.site = parsed.getProperty ("site", {});

        int failed = 0;
        if (const auto* missing = parsed.getProperty ("missingFingerprints", {}).getArray())
        {
            for (const auto& id : *missing)
            {
                const auto it = files.find (id.toString());
                juce::MemoryBlock data;
                if (it == files.end() || ! it->second.loadFileAsData (data)) { ++failed; continue; }
                const auto put = request ("PUT", base + "/api/plugin/works/" + workId + "/fingerprints/" + id.toString(),
                                          a.key, data, "application/octet-stream");
                if (put.status == 200) ++out.uploaded; else ++failed;
            }
        }

        out.ok = true;
        out.message = "Synced \"" + out.title + "\"" + (out.uploaded > 0 ? ", " + juce::String (out.uploaded) + (out.uploaded == 1 ? " fingerprint" : " fingerprints") + " uploaded" : juce::String())
                    + (failed > 0 ? ". " + juce::String (failed) + " fingerprint file(s) could not be found on this computer" : juce::String());
        return out;
    }

    /** Someone's account as their Artist ID reveals it: enough to put them on a split sheet. */
    struct Artist
    {
        bool ok = false;
        juce::String message, artistId, artistName, legalName, role, pro, ipi, publisher, publisherIpi;
    };

    inline Artist getJson (const Account& a, const juce::String& path, juce::var& parsed)
    {
        Artist out;
        if (! a.linked()) { out.message = "Link this computer to your account first (Evidence tab)"; return out; }
        if (const auto problem = serverProblem (a.server); problem.isNotEmpty()) { out.message = problem; return out; }
        const auto reply = request ("GET", a.server.trimCharactersAtEnd ("/") + path, a.key, {}, "application/json");
        parsed = juce::JSON::parse (reply.body);
        if (reply.status == 0) { out.message = "Could not reach " + juce::URL (a.server).getDomain(); return out; }
        if (reply.status != 200) { out.message = parsed.getProperty ("error", "The server said no (" + juce::String (reply.status) + ")").toString(); return out; }
        out.ok = true;
        return out;
    }

    /** Looks up the person being added to the split sheet. They must have signed up. */
    inline Artist lookupArtist (const Account& a, const juce::String& artistId)
    {
        juce::var v;
        auto out = getJson (a, "/api/plugin/artists/" + juce::URL::addEscapeChars (artistId, true), v);
        if (! out.ok) return out;
        out.artistId = v.getProperty ("artistId", {}).toString();
        out.artistName = v.getProperty ("artistName", {}).toString();
        out.legalName = v.getProperty ("legalName", {}).toString();
        out.role = v.getProperty ("role", {}).toString();
        out.pro = v.getProperty ("pro", {}).toString();
        out.ipi = v.getProperty ("ipi", {}).toString();
        out.publisher = v.getProperty ("publisher", {}).toString();
        out.publisherIpi = v.getProperty ("publisherIpi", {}).toString();
        return out;
    }

    /** Which account this computer is linked to. */
    inline Artist whoAmI (const Account& a)
    {
        juce::var v;
        auto out = getJson (a, "/api/plugin/whoami", v);
        if (! out.ok) return out;
        out.artistId = v.getProperty ("artistId", {}).toString();
        out.artistName = v.getProperty ("artistName", {}).toString();
        out.legalName = v.getProperty ("legalName", {}).toString();
        return out;
    }
}
