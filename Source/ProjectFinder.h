#pragma once
#include <juce_core/juce_core.h>
#include "Config.h"
#if JUCE_MAC
 #include <libproc.h>
 #include <unistd.h>
 #include <vector>
#elif JUCE_LINUX
 #include <unistd.h>
#endif

/** Finds the DAW project this plugin is running in, without asking the user.

    A plugin is never told which project it belongs to. What it can see is which files the
    host program currently holds open, so this looks through those for a known project type
    (.logicx, .flp, .als, .ptx ...). It only reads the list of open files, never their contents.

    Works on macOS and Linux. On Windows it finds nothing and the project is picked once by hand. */
namespace ProjectFinder
{
    /** The project a path belongs to: the file itself, or the project package/folder it sits inside. */
    inline juce::File projectRoot (juce::File f)
    {
        for (int depth = 0; depth < 12 && f.getFullPathName().length() > 1; ++depth)
        {
            if (Config::dawForProjectFile (f).isNotEmpty()) return f;
            const auto parent = f.getParentDirectory();
            if (parent == f) break;
            f = parent;
        }
        return {};
    }

    /** Projects the host has open right now. Empty when the host does not keep its project file open. */
    inline juce::StringArray openProjects()
    {
        juce::StringArray found;
       #if JUCE_MAC
        const auto home = juce::File::getSpecialLocation (juce::File::userHomeDirectory).getFullPathName();
        // This process (plugins loaded inside the DAW) and its parent...
        std::vector<pid_t> pids { getpid(), getppid() };
        // ...and DAWs that run their plugins in a separate helper process (Logic Pro, GarageBand, MainStage),
        // where the project is held open by the DAW itself, not by the process this plugin is in.
        std::vector<pid_t> all ((size_t) juce::jmax (0, proc_listallpids (nullptr, 0)) + 64);
        const int count = proc_listallpids (all.data(), (int) (all.size() * sizeof (pid_t)));
        // (Tests set SPLIT_TRACKER_OWN_PROCESS_ONLY so a DAW that happens to be running cannot affect them.)
        for (int i = 0; i < count && std::getenv ("SPLIT_TRACKER_OWN_PROCESS_ONLY") == nullptr; ++i)
        {
            char exe[PROC_PIDPATHINFO_MAXSIZE] {};
            if (proc_pidpath (all[(size_t) i], exe, sizeof (exe)) <= 0) continue;
            const auto exePath = juce::String::fromUTF8 (exe);
            if (exePath.endsWith ("/MacOS/Logic Pro") || exePath.endsWith ("/MacOS/Logic Pro X")
                 || exePath.endsWith ("/MacOS/GarageBand") || exePath.endsWith ("/MacOS/MainStage"))
                pids.push_back (all[(size_t) i]);
        }

        for (const pid_t pid : pids)
        {
            if (pid <= 1) continue;
            const int bytes = proc_pidinfo (pid, PROC_PIDLISTFDS, 0, nullptr, 0);
            if (bytes <= 0) continue;
            std::vector<proc_fdinfo> fds ((size_t) bytes / sizeof (proc_fdinfo) + 8);
            const int got = proc_pidinfo (pid, PROC_PIDLISTFDS, 0, fds.data(), (int) (fds.size() * sizeof (proc_fdinfo)));
            for (size_t i = 0; i < (size_t) juce::jmax (0, got) / sizeof (proc_fdinfo); ++i)
            {
                if (fds[i].proc_fdtype != PROX_FDTYPE_VNODE) continue;
                vnode_fdinfowithpath info {};
                if (proc_pidfdinfo (pid, fds[i].proc_fd, PROC_PIDFDVNODEPATHINFO, &info, sizeof (info)) != (int) sizeof (info)) continue;
                const juce::String path (juce::CharPointer_UTF8 (info.pvip.vip_path));
                // Only the user's own files: not templates inside an app or the system.
                if (! path.startsWith (home) || path.contains ("/Library/") || path.contains (".app/")) continue;
                const auto root = projectRoot (juce::File (path));
                if (root != juce::File()) found.addIfNotAlreadyThere (root.getFullPathName());
            }
        }
       #elif JUCE_LINUX
        // On Linux every DAW loads plugins into its own process, so its open files are under /proc/self/fd.
        const auto home = juce::File::getSpecialLocation (juce::File::userHomeDirectory).getFullPathName();
        for (const auto& entry : juce::RangedDirectoryIterator (juce::File ("/proc/self/fd"), false, "*", juce::File::findFilesAndDirectories))
        {
            char target[4096] {};
            const auto len = ::readlink (entry.getFile().getFullPathName().toRawUTF8(), target, sizeof (target) - 1);
            if (len <= 0) continue;
            const auto path = juce::String::fromUTF8 (target, (int) len);
            if (! path.startsWith (home)) continue;
            const auto root = projectRoot (juce::File (path));
            if (root != juce::File()) found.addIfNotAlreadyThere (root.getFullPathName());
        }
       #endif
        // Windows: there is no supported way to list another program's (or our own) open files by
        // name, so nothing is found here and the user picks the project once with "Sign project file...".
        return found;
    }
}
