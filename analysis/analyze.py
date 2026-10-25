#!/usr/bin/env python3
"""
Offline DSP song analysis for Song Arcade.
Usage: python analysis/analyze.py <mp3_path> <out_json_path>
"""
import json
import os
import sys
import warnings

import librosa
import numpy as np

warnings.filterwarnings("ignore")


def normalize_95(arr: np.ndarray) -> np.ndarray:
    if arr.size == 0:
        return arr
    p95 = float(np.percentile(arr, 95))
    if p95 <= 1e-8:
        p95 = float(np.max(arr))
    if p95 <= 1e-8:
        return np.zeros_like(arr)
    return np.clip(arr / p95, 0.0, 1.0)


def analyze_audio(mp3_path: str, out_json_path: str) -> None:
    sr_target = 22050
    hop_length = 512

    y, sr = librosa.load(mp3_path, sr=sr_target, mono=True)
    duration = float(librosa.get_duration(y=y, sr=sr))

    # 1. Mel spectrogram & band splits (<150 Hz, 150-2000 Hz, >2000 Hz)
    n_mels = 128
    S = librosa.feature.melspectrogram(
        y=y, sr=sr, n_mels=n_mels, fmin=20.0, fmax=sr / 2.0, hop_length=hop_length
    )
    mel_freqs = librosa.mel_frequencies(n_mels=n_mels, fmin=20.0, fmax=sr / 2.0)

    low_mask = mel_freqs < 150.0
    mid_mask = (mel_freqs >= 150.0) & (mel_freqs <= 2000.0)
    high_mask = mel_freqs > 2000.0
    if not np.any(low_mask):
        low_mask[0] = True
    if not np.any(mid_mask):
        mid_mask[len(mel_freqs) // 2] = True
    if not np.any(high_mask):
        high_mask[-1] = True

    def compute_band_onset_env(mask: np.ndarray) -> np.ndarray:
        S_band = S[mask, :]
        S_db = librosa.power_to_db(S_band, ref=np.max)
        env = librosa.onset.onset_strength(S=S_db, sr=sr, hop_length=hop_length)
        return env

    onset_env_low = compute_band_onset_env(low_mask)
    onset_env_mid = compute_band_onset_env(mid_mask)
    onset_env_high = compute_band_onset_env(high_mask)

    # 2. Tempo and beats (folded into 70..180 BPM)
    tempo, beat_frames = librosa.beat.beat_track(
        y=y, sr=sr, hop_length=hop_length, units="frames"
    )
    raw_bpm = float(np.atleast_1d(tempo)[0])
    if raw_bpm <= 0 or np.isnan(raw_bpm):
        raw_bpm = 120.0

    beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop_length).tolist()

    # Extrapolate beat grid to cover [0, duration] if needed
    if len(beat_times) >= 2:
        median_period = float(np.median(np.diff(beat_times)))
    else:
        median_period = 60.0 / raw_bpm
        beat_times = list(np.arange(0.0, duration, median_period))

    if median_period > 0:
        prepend = []
        t_cur = beat_times[0] - median_period
        while t_cur >= 0.05:
            prepend.append(t_cur)
            t_cur -= median_period
        if prepend:
            beat_times = list(reversed(prepend)) + beat_times

        t_cur = beat_times[-1] + median_period
        while t_cur < duration - 0.05:
            beat_times.append(t_cur)
            t_cur += median_period

    bpm = raw_bpm
    while bpm < 70.0 and len(beat_times) >= 2:
        bpm *= 2.0
        expanded = []
        for i in range(len(beat_times) - 1):
            expanded.append(beat_times[i])
            expanded.append(0.5 * (beat_times[i] + beat_times[i + 1]))
        expanded.append(beat_times[-1])
        beat_times = expanded

    while bpm > 180.0 and len(beat_times) >= 4:
        bpm /= 2.0
        f_idx = np.clip(
            librosa.time_to_frames(beat_times, sr=sr, hop_length=hop_length),
            0,
            max(0, len(onset_env_low) - 1),
        )
        sum0 = float(np.sum(onset_env_low[f_idx[0::2]]))
        sum1 = float(np.sum(onset_env_low[f_idx[1::2]]))
        parity = 0 if sum0 >= sum1 else 1
        beat_times = beat_times[parity::2]

    bpm = round(float(bpm), 1)
    beats = [round(float(t), 3) for t in beat_times if 0.0 <= t <= duration]

    # 3. Downbeats: for each phase 0..3, sum low-band onset strength at beats[phase::4]. Pick the max.
    if len(beats) >= 4:
        beat_f = np.clip(
            librosa.time_to_frames(beats, sr=sr, hop_length=hop_length),
            0,
            max(0, len(onset_env_low) - 1),
        )
        phase_sums = [
            float(np.sum(onset_env_low[beat_f[phase::4]])) for phase in range(4)
        ]
        best_phase = int(np.argmax(phase_sums))
        downbeats = [round(float(t), 3) for t in beats[best_phase::4]]
    else:
        downbeats = beats[:]

    # 4. Peak-pick band onsets and normalize s to 0..1
    def pick_band_onsets(env: np.ndarray) -> list[dict]:
        if env.size == 0 or float(np.max(env)) <= 1e-8:
            return []
        env_norm = env / float(np.max(env))
        delta = max(0.06, float(np.percentile(env_norm, 70)) * 0.35)
        peaks = librosa.util.peak_pick(
            env_norm,
            pre_max=3,
            post_max=3,
            pre_avg=4,
            post_avg=4,
            delta=delta,
            wait=3,
        )
        if len(peaks) == 0:
            return []
        strengths = env[peaks]
        s_ref = float(np.percentile(strengths, 95))
        if s_ref <= 1e-8:
            s_ref = float(np.max(strengths))
        times = librosa.frames_to_time(peaks, sr=sr, hop_length=hop_length)
        out = []
        for t_val, s_val in zip(times, strengths):
            if 0.0 <= t_val <= duration:
                s_norm = float(np.clip(s_val / max(s_ref, 1e-8), 0.0, 1.0))
                out.append({"t": round(float(t_val), 3), "s": round(s_norm, 3)})
        return out

    onsets_low = pick_band_onsets(onset_env_low)
    onsets_mid = pick_band_onsets(onset_env_mid)
    onsets_high = pick_band_onsets(onset_env_high)

    # 5. Envelope at 0.05 s hop: RMS energy + low, mid, high band energy (normalized by 95th percentile)
    rms_frames = librosa.feature.rms(y=y, frame_length=2048, hop_length=hop_length)[0]
    low_rms = np.sqrt(np.mean(S[low_mask, :], axis=0))
    mid_rms = np.sqrt(np.mean(S[mid_mask, :], axis=0))
    high_rms = np.sqrt(np.mean(S[high_mask, :], axis=0))

    frame_times = librosa.frames_to_time(
        np.arange(len(rms_frames)), sr=sr, hop_length=hop_length
    )
    env_hop = 0.05
    env_grid = np.arange(0.0, duration, env_hop)

    def resample_and_norm(series: np.ndarray) -> list[float]:
        n = min(len(frame_times), len(series))
        if n == 0:
            return [0.0] * len(env_grid)
        interp = np.interp(env_grid, frame_times[:n], series[:n])
        normed = normalize_95(interp)
        return [round(float(x), 3) for x in normed]

    env_energy = resample_and_norm(rms_frames)
    env_low = resample_and_norm(low_rms)
    env_mid = resample_and_norm(mid_rms)
    env_high = resample_and_norm(high_rms)

    # 6. Waveform: absolute peak per 0.01 s, normalized 0..1
    wf_hop = 0.01
    n_wf_bins = max(1, int(np.ceil(duration / wf_hop)))
    edges = np.linspace(0, len(y), n_wf_bins + 1, dtype=int)
    abs_y = np.abs(y)
    wf_peaks = np.zeros(n_wf_bins, dtype=np.float32)
    for i in range(n_wf_bins):
        seg = abs_y[edges[i] : max(edges[i] + 1, edges[i + 1])]
        wf_peaks[i] = float(np.max(seg)) if seg.size > 0 else 0.0
    wf_max = float(np.max(wf_peaks)) if wf_peaks.size > 0 else 1.0
    if wf_max <= 1e-8:
        wf_max = 1.0
    waveform_peaks = [round(float(x / wf_max), 3) for x in np.clip(wf_peaks / wf_max, 0.0, 1.0)]

    # 7. Melody direction at mid and high onsets
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop_length)
    stft_mag = np.abs(librosa.stft(y, n_fft=2048, hop_length=hop_length))
    fft_freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
    fft_mid_mask = (fft_freqs >= 150.0) & (fft_freqs <= 2000.0)
    stft_mid = stft_mag[fft_mid_mask, :]
    mid_freqs_col = fft_freqs[fft_mid_mask, None]
    mid_centroid_frames = np.sum(mid_freqs_col * stft_mid, axis=0) / (
        np.sum(stft_mid, axis=0) + 1e-8
    )

    merged_mh_times: list[float] = sorted(
        [o["t"] for o in onsets_mid] + [o["t"] for o in onsets_high]
    )
    dedup_mh_times: list[float] = []
    for t_val in merged_mh_times:
        if not dedup_mh_times or (t_val - dedup_mh_times[-1]) >= 0.03:
            dedup_mh_times.append(t_val)

    melody = []
    prev_centroid = None
    centroid_threshold = 35.0
    n_chroma_frames = chroma.shape[1]
    n_cent_frames = len(mid_centroid_frames)

    for t_val in dedup_mh_times:
        f_idx = int(librosa.time_to_frames(t_val, sr=sr, hop_length=hop_length))
        fc = min(max(0, f_idx), n_chroma_frames - 1)
        fm = min(max(0, f_idx), n_cent_frames - 1)
        pc = int(np.argmax(chroma[:, fc]))
        cent = float(mid_centroid_frames[fm])
        if prev_centroid is None:
            direction = 0
        else:
            diff = cent - prev_centroid
            if abs(diff) > centroid_threshold:
                direction = 1 if diff > 0 else -1
            else:
                direction = 0
        prev_centroid = cent
        melody.append({"t": round(float(t_val), 3), "dir": int(direction), "pc": int(pc)})

    # 8. Section candidates: agglomerative segmentation on beat-synced stacked chroma + MFCC (~10 segments)
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13, hop_length=hop_length)
    mfcc_norm = librosa.util.normalize(mfcc, axis=1)
    chroma_norm = librosa.util.normalize(chroma, axis=1)
    stacked_feat = np.vstack([chroma_norm, mfcc_norm])

    if len(beat_frames) >= 12:
        sync_feat = librosa.util.sync(stacked_feat, beat_frames, aggregate=np.median)
        k_segs = min(12, max(6, min(sync_feat.shape[1] // 2, 10)))
        bound_beats = librosa.segment.agglomerative(sync_feat, k_segs)
        bound_frames = beat_frames[np.clip(bound_beats, 0, len(beat_frames) - 1)]
        raw_bound_times = librosa.frames_to_time(bound_frames, sr=sr, hop_length=hop_length).tolist()
    else:
        k_segs = min(10, max(4, int(duration // 12)))
        bound_frames = librosa.segment.agglomerative(stacked_feat, k_segs)
        raw_bound_times = librosa.frames_to_time(bound_frames, sr=sr, hop_length=hop_length).tolist()

    # Snap interior boundaries to nearest downbeat
    snapped_bounds = [0.0]
    if len(downbeats) > 0:
        db_arr = np.array(downbeats)
        for bt in raw_bound_times[1:]:
            if bt <= 1.0 or bt >= duration - 1.0:
                continue
            nearest_db = float(db_arr[int(np.argmin(np.abs(db_arr - bt)))])
            if 0.0 < nearest_db < duration:
                snapped_bounds.append(round(nearest_db, 3))
    else:
        for bt in raw_bound_times[1:]:
            if 0.0 < bt < duration:
                snapped_bounds.append(round(float(bt), 3))

    snapped_bounds.append(round(duration, 3))
    snapped_bounds = sorted(list(set(snapped_bounds)))

    # Merge any segment shorter than 8 s
    while len(snapped_bounds) > 2:
        lengths = [
            snapped_bounds[i + 1] - snapped_bounds[i]
            for i in range(len(snapped_bounds) - 1)
        ]
        min_idx = int(np.argmin(lengths))
        if lengths[min_idx] >= 8.0:
            break
        # Remove interior boundary
        if min_idx == 0:
            del snapped_bounds[1]
        elif min_idx == len(lengths) - 1:
            del snapped_bounds[-2]
        else:
            # Merge with whichever adjacent segment is shorter
            if lengths[min_idx - 1] <= lengths[min_idx + 1]:
                del snapped_bounds[min_idx]
            else:
                del snapped_bounds[min_idx + 1]

    all_onset_times = np.array(
        sorted([o["t"] for o in onsets_low] + [o["t"] for o in onsets_mid] + [o["t"] for o in onsets_high])
    )
    env_energy_arr = np.array(env_energy)

    section_candidates = []
    for i in range(len(snapped_bounds) - 1):
        s_t = float(snapped_bounds[i])
        e_t = float(snapped_bounds[i + 1])
        seg_dur = max(0.001, e_t - s_t)
        i0 = max(0, int(np.floor(s_t / env_hop)))
        i1 = min(len(env_energy_arr), max(i0 + 1, int(np.ceil(e_t / env_hop))))
        mean_e = float(np.mean(env_energy_arr[i0:i1])) if i1 > i0 else 0.0
        n_onsets = int(np.sum((all_onset_times >= s_t) & (all_onset_times < e_t)))
        density = n_onsets / seg_dur
        section_candidates.append(
            {
                "start": round(s_t, 3),
                "end": round(e_t, 3),
                "energy": round(mean_e, 3),
                "onsetDensity": round(density, 2),
            }
        )

    # 9. Drop candidates: boundaries where mean energy rises most from previous segment
    drop_candidates = []
    for i in range(1, len(section_candidates)):
        prev_e = section_candidates[i - 1]["energy"]
        curr_e = section_candidates[i]["energy"]
        rise = curr_e - prev_e
        if rise > 0.02:
            drop_candidates.append(
                {
                    "t": section_candidates[i]["start"],
                    "energyRise": round(float(rise), 3),
                    "preEnergy": round(float(prev_e), 3),
                    "postEnergy": round(float(curr_e), 3),
                }
            )

    # Also check 4-bar downbeat boundaries for sharp local energy jumps if few segment rises
    for db_t in downbeats:
        if db_t < 12.0 or db_t > duration - 12.0:
            continue
        if any(abs(d["t"] - db_t) < 2.0 for d in drop_candidates):
            continue
        pre_i0 = max(0, int((db_t - 8.0) / env_hop))
        pre_i1 = max(pre_i0 + 1, int(db_t / env_hop))
        post_i0 = pre_i1
        post_i1 = min(len(env_energy_arr), max(post_i0 + 1, int((db_t + 8.0) / env_hop)))
        pre_e = float(np.mean(env_energy_arr[pre_i0:pre_i1]))
        post_e = float(np.mean(env_energy_arr[post_i0:post_i1]))
        rise = post_e - pre_e
        if rise >= 0.18 and post_e >= 0.55:
            drop_candidates.append(
                {
                    "t": round(float(db_t), 3),
                    "energyRise": round(float(rise), 3),
                    "preEnergy": round(float(pre_e), 3),
                    "postEnergy": round(float(post_e), 3),
                }
            )

    drop_candidates.sort(key=lambda d: d["energyRise"], reverse=True)
    if not drop_candidates and len(section_candidates) >= 2:
        # Pick highest energy section start > 0
        best_sec = max(section_candidates[1:], key=lambda s: s["energy"])
        drop_candidates.append(
            {
                "t": best_sec["start"],
                "energyRise": round(float(best_sec["energy"] - section_candidates[0]["energy"]), 3),
                "preEnergy": section_candidates[0]["energy"],
                "postEnergy": best_sec["energy"],
            }
        )

    # 10. Phrases: every 4 bars from the first downbeat, plus every section candidate start, deduplicated
    raw_phrases = sorted(
        list(set([round(float(t), 3) for t in downbeats[0::4]] + [s["start"] for s in section_candidates]))
    )
    phrases = []
    for t_val in raw_phrases:
        if not phrases or abs(t_val - phrases[-1]) > 0.05:
            phrases.append(t_val)

    output = {
        "duration": round(duration, 3),
        "bpm": bpm,
        "beats": beats,
        "downbeats": downbeats,
        "phrases": phrases,
        "onsets": {
            "low": onsets_low,
            "mid": onsets_mid,
            "high": onsets_high,
        },
        "envelope": {
            "hop": env_hop,
            "energy": env_energy,
            "low": env_low,
            "mid": env_mid,
            "high": env_high,
        },
        "waveform": {
            "hop": wf_hop,
            "peaks": waveform_peaks,
        },
        "melody": melody,
        "sectionCandidates": section_candidates,
        "dropCandidates": drop_candidates[:8],
    }

    os.makedirs(os.path.dirname(os.path.abspath(out_json_path)), exist_ok=True)
    with open(out_json_path, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2)

    # Print summary
    print(f"=== DSP Summary: {os.path.basename(mp3_path)} ===")
    print(f"Duration: {duration:.2f}s | BPM: {bpm:.1f} | Beats: {len(beats)} | Downbeats: {len(downbeats)}")
    print(
        f"Onsets -> low: {len(onsets_low)}, mid: {len(onsets_mid)}, high: {len(onsets_high)} | Melody pts: {len(melody)}"
    )
    print("Candidate Sections:")
    for idx, sc in enumerate(section_candidates):
        print(
            f"  [{idx}] {sc['start']:6.2f}s .. {sc['end']:6.2f}s "
            f"(dur {sc['end'] - sc['start']:5.1f}s) | energy={sc['energy']:.3f} | density={sc['onsetDensity']:.2f}/s"
        )
    print(
        "Drop Candidates:",
        ", ".join([f"{d['t']:.2f}s (+{d['energyRise']:.2f})" for d in drop_candidates[:5]]),
    )


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python analysis/analyze.py <mp3> <out.json>", file=sys.stderr)
        sys.exit(1)
    analyze_audio(sys.argv[1], sys.argv[2])
