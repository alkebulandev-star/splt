# How accurate is melody matching?

> **Always state with these numbers:** a melody re-sung by another voice or replayed on another
> instrument (a cover) has **not** been tested. There were no such pairs to measure.

Measured on 13 November 2026 with `node tools/melody-eval.ts`, on real music from this computer
(24 different songs and beats, 50-second references, 25-second clips). Rerun it on any folder of
songs to check these numbers; nothing is uploaded.

## What it is for

The acoustic fingerprint recognises the same recording, even after MP3 conversion. It does not
recognise a recording that has been pitched or sped up or down, which is how songs are commonly
disguised when reposted. Melody matching covers that gap. It compares which notes sound over
time (melody and harmony together), not the recording itself.

## Real songs, changed in pitch and speed

| Change made to the clip | "Same melody" | "Possibly" | Plain fingerprint |
|---|---|---|---|
| MP3 copy, unchanged | 24 of 24 | 24 of 24 | 24 of 24 |
| Pitch up 2 semitones | 24 of 24 | 24 of 24 | 0 of 24 |
| Pitch down 3 semitones | 20 of 24 | 22 of 24 | 0 of 24 |
| Sped up 12% | 24 of 24 | 24 of 24 | 0 of 24 |
| Slowed 11% | 22 of 24 | 24 of 24 | 0 of 24 |
| Tempo up 8%, same key | 24 of 24 | 24 of 24 | 0 of 24 |
| **All changed clips** | **114 of 120 (95%)** | **118 of 120 (98%)** | **0 of 120** |

Different songs wrongly matched, out of 3,228 comparisons: **0** as "same melody", **6 (0.2%)**
as "possibly". Two of those six were `master_output` against `final_mix`, which may be one song.

## One stem against the full mix of its song

Three real 8-stem songs, 13-second clips of each stem against the full mix:

- The plain fingerprint found 0 of 24 stems inside their mix.
- Melody matching found 17 of 22 pitched stems as "possibly" (16 of 22 when the stem was also
  moved up 2 semitones). Drums and bass were not found, as expected.
- Wrong songs matched as "possibly": 20 of 1,248 comparisons (1.6%). None as "same melody",
  because clips under 20 seconds are never given that label.

This works because the stems of one song share its notes. It is a lead worth listening to, not proof.

## How results are tagged

| Result | Tag | Meaning |
|---|---|---|
| Same recording | **Evidence** | The audio itself matches. |
| Same melody | **Strong lead** | Notes match; not the same recording. |
| Shares material | **Lead** | Partial audio match; could be a shared beat or sample. |
| Possibly the same melody, including a stem inside a full mix | **Lead** | Worth listening to. Not proof. |

## The two levels

- **Same melody**: similarity 0.85 or more, clear of other keys by 0.20 or more, and at least 20
  seconds compared.
- **Possibly the same melody**: similarity 0.80 or more and clear by 0.15 or more. Shown only for
  the single closest song in the library.

## What has not been tested

- A melody re-sung by another voice or replayed on another instrument (a cover). There were no
  such pairs on this computer. The synthetic tests cover it for single-line tunes only.
- Songs that share a chord loop or sample pack. They are likely to match as "possibly".
- Changes larger than 3 semitones or 12% in speed, live recordings, and heavily remixed versions.
- A larger library. With thousands of songs the false-match count will grow, so the thresholds
  should be measured again then.
