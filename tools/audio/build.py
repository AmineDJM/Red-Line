#!/usr/bin/env python3
"""
Red Line — pipeline audio reproductible.

  python3 tools/audio/build.py fetch   # génère les sons manquants avec ElevenLabs (cache : tools/audio/.cache/raw)
  python3 tools/audio/build.py build   # découpe, boucle sans clic, normalise, encode (Opus/WebM + AAC/M4A)
  python3 tools/audio/build.py check   # contrôle : durées, sonie (EBU R128), crêtes, clics aux jointures

Dépendances : curl, ffmpeg/ffprobe (libopus), Python 3 et numpy (`pip install numpy`).
Le proxy de l'environnement injecte l'authentification ElevenLabs : aucune clé n'est lue ici, et les
requêtes ne contiennent que les descriptions de sons (aucune donnée personnelle).
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
SPEC = json.loads((HERE / "sounds.json").read_text())
RAW = HERE / ".cache" / "raw"
WORK = HERE / ".cache" / "work"
OUT = ROOT / "apps" / "client" / "public" / "audio"
API = "https://api.elevenlabs.io/v1"
RATE = 48000

# Fondu enchaîné à la jointure des boucles (secondes).
LOOP_XFADE = {"music": 4.0, "ambience": 2.5}
# Débits : musique stéréo, ambiances mono, effets mono (stéréo pour les ponctuations orchestrales).
OPUS_KBPS = {"music": 56, "ambience": 28, "sfx": 40, "sfx-stereo": 56}
AAC_KBPS = {"music": 80, "ambience": 40, "sfx": 56, "sfx-stereo": 72}
# Marges des boucles : le fichier encodé contient [fin de boucle] + boucle + [début de boucle], et le
# client boucle entre `loopStart` et `loopEnd`. Les imperfections des codecs aux bords du fichier
# (amorçage Opus, remplissage AAC) restent dans les marges : la jointure est exacte à l'échantillon.
LOOP_PAD = 0.25


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw)


def entries():
    for kind in ("music", "ambience", "sfx"):
        for e in SPEC[kind]:
            yield kind, e


# ——— Génération ———


def fetch_one(kind: str, e: dict) -> None:
    dst = RAW / f"{e['id']}.mp3"
    if dst.exists() and dst.stat().st_size > 1000:
        return
    if kind == "music":
        url = f"{API}/music?output_format=mp3_44100_128"
        body = {
            "prompt": e["prompt"],
            "music_length_ms": int(e["seconds"] * 1000),
            "force_instrumental": True,
        }
    else:
        url = f"{API}/sound-generation?output_format=mp3_44100_128"
        body = {
            "text": e["prompt"],
            "duration_seconds": e["seconds"],
            "prompt_influence": 0.5,
            "model_id": "eleven_text_to_sound_v2",
        }
        if kind == "ambience":
            body["loop"] = True
    tmp = dst.with_suffix(".part")
    print(f"  génère {e['id']} ({kind}, {e['seconds']} s)…", flush=True)
    r = subprocess.run(
        [
            "curl", "-sS", "--fail-with-body", "-X", "POST", url,
            "-H", "Content-Type: application/json",
            "-d", json.dumps(body), "-o", str(tmp), "-w", "%{http_code}",
        ],
        capture_output=True, text=True,
    )
    if r.returncode != 0 or not tmp.exists() or tmp.stat().st_size < 1000:
        msg = tmp.read_text(errors="replace")[:400] if tmp.exists() else r.stderr
        raise SystemExit(f"échec {e['id']} : HTTP {r.stdout} {msg}")
    tmp.rename(dst)


def cmd_fetch(only: list[str]) -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    for kind, e in entries():
        if only and e["id"] not in only:
            continue
        fetch_one(kind, e)


# ——— Mesures ———


def duration(path: Path) -> float:
    r = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)])
    return float(r.stdout.strip())


def loudness(path: Path) -> dict:
    """Sonie intégrée (LUFS), crête vraie (dBTP) et étendue, via le filtre loudnorm (passe de mesure)."""
    r = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-af",
         "loudnorm=I=-18:TP=-1:LRA=11:print_format=json", "-f", "null", "-"],
        capture_output=True, text=True,
    )
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", r.stderr, re.S)
    if not m:
        raise SystemExit(f"loudnorm illisible pour {path}")
    d = json.loads(m.group(0))
    return {k: float(d[k]) for k in ("input_i", "input_tp", "input_lra")}


def max_volume(path: Path) -> float:
    r = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-af", "volumedetect", "-f", "null", "-"],
        capture_output=True, text=True,
    )
    m = re.search(r"max_volume:\s*(-?[\d.]+) dB", r.stderr)
    return float(m.group(1)) if m else 0.0


# ——— Traitement ———


def to_wav(src: Path, dst: Path, channels: int, af: str | None = None) -> None:
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(src)]
    if af:
        cmd += ["-af", af]
    cmd += ["-ac", str(channels), "-ar", str(RATE), "-c:a", "pcm_f32le", str(dst)]
    run(cmd)


def make_loop(src: Path, dst: Path, xfade: float) -> None:
    """
    Boucle sans clic : la queue (fondu sortant) est mixée sur la tête (fondu entrant, puissance constante).
    Fichier final = [queue × tête] + corps ; la fin du corps s'enchaîne sur la queue, et la tête sur le corps.
    """
    total = duration(src)
    c = xfade
    fc = (
        f"[0:a]asplit=3[a][b][c];"
        f"[a]atrim=0:{c},asetpts=PTS-STARTPTS,afade=t=in:d={c}:curve=qsin[head];"
        f"[b]atrim={c}:{total - c},asetpts=PTS-STARTPTS[body];"
        f"[c]atrim={total - c}:{total},asetpts=PTS-STARTPTS,afade=t=out:d={c}:curve=qsin[tail];"
        f"[tail][head]amix=inputs=2:normalize=0:duration=shortest[x];"
        f"[x][body]concat=n=2:v=0:a=1[out]"
    )
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(src),
         "-filter_complex", fc, "-map", "[out]", "-c:a", "pcm_f32le", str(dst)])


def trim_edges(src: Path, dst: Path, channels: int) -> None:
    """
    Musique générée : retire une éventuelle intro en crescendo et une fin en fondu, pour que la boucle
    garde un niveau constant (enveloppe RMS par fenêtres de 0,5 s, lissée sur 2 s ; seuil : médiane − 5 dB).
    """
    import numpy as np

    x = decode(src, channels).mean(axis=1)
    n = RATE // 2
    env = np.array([20 * np.log10(np.sqrt((x[i:i + n] ** 2).mean()) + 1e-9)
                    for i in range(0, len(x) - n + 1, n)])
    smooth = np.convolve(env, np.ones(4) / 4, mode="same")
    med = float(np.median(env))
    a, b = 0, len(env)
    while a < b - 16 and smooth[a] < med - 5:
        a += 1
    while b > a + 16 and smooth[b - 1] < med - 5:
        b -= 1
    total = duration(src)
    start, end = a * 0.5, min(total, b * 0.5)
    if start > 0 or end < total - 0.25:
        print(f"    bords retirés : {total:.1f} s → [{start:.1f} ; {end:.1f}] s")
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(src),
         "-af", f"atrim={start}:{end},asetpts=PTS-STARTPTS", "-c:a", "pcm_f32le", str(dst)])


def pad(src: Path, dst: Path, p: float) -> None:
    """[p dernières secondes] + boucle + [p premières secondes]."""
    total = duration(src)
    fc = (
        f"[0:a]asplit=3[a][b][c];"
        f"[a]atrim={total - p}:{total},asetpts=PTS-STARTPTS[pre];"
        f"[c]atrim=0:{p},asetpts=PTS-STARTPTS[post];"
        f"[pre][b][post]concat=n=3:v=0:a=1[out]"
    )
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(src),
         "-filter_complex", fc, "-map", "[out]", "-c:a", "pcm_f32le", str(dst)])


def normalize(src: Path, dst: Path, e: dict) -> float:
    """Gain fixe (pas de compression) vers la sonie cible, crête vraie plafonnée à −1 dBTP."""
    if "peak" in e:
        gain = e["peak"] - max_volume(src)
    else:
        m = loudness(src)
        if m["input_i"] < -60:
            gain = -6 - max_volume(src)
        else:
            gain = min(e["lufs"] - m["input_i"], -1.0 - m["input_tp"])
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(src),
         "-af", f"volume={gain:.2f}dB,alimiter=limit=0.891:level=false:attack=2:release=40:latency=1",
         "-c:a", "pcm_f32le", str(dst)])
    return gain


def encode(src: Path, base: Path, profile: str) -> dict:
    base.parent.mkdir(parents=True, exist_ok=True)
    webm = base.with_suffix(".webm")
    m4a = base.with_suffix(".m4a")
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(src),
         "-c:a", "libopus", "-b:a", f"{OPUS_KBPS[profile]}k", "-vbr", "on",
         "-compression_level", "10", "-application", "audio", "-map_metadata", "-1", str(webm)])
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(src),
         "-ar", "44100", "-c:a", "aac", "-b:a", f"{AAC_KBPS[profile]}k",
         "-map_metadata", "-1", "-movflags", "+faststart", str(m4a)])
    return {"webm": webm.stat().st_size, "m4a": m4a.stat().st_size}


def cmd_build(only: list[str]) -> None:
    WORK.mkdir(parents=True, exist_ok=True)
    manifest_path = OUT / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"sounds": {}}
    sounds = manifest.get("sounds", {})
    for kind, e in entries():
        sid = e["id"]
        if only and sid not in only:
            continue
        raw = RAW / f"{sid}.mp3"
        if not raw.exists():
            print(f"  {sid} : source absente (lancer fetch)")
            continue
        print(f"  {sid}", flush=True)
        stereo = kind == "music" or e.get("stereo", False)
        a = WORK / f"{sid}.a.wav"
        b = WORK / f"{sid}.b.wav"
        c = WORK / f"{sid}.c.wav"
        if kind == "sfx":
            # Silence de tête retiré (réactivité), traîne coupée sous −60 dB, micro-fondus anti-clic.
            to_wav(raw, a, 2 if stereo else 1,
                   "silenceremove=start_periods=1:start_threshold=-55dB:start_silence=0.004,"
                   "areverse,silenceremove=start_periods=1:start_threshold=-60dB,areverse")
            d = duration(a)
            fade = min(0.35, d * 0.2)
            run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(a), "-af",
                 f"afade=t=in:d=0.004,afade=t=out:st={d - fade:.3f}:d={fade:.3f}",
                 "-c:a", "pcm_f32le", str(b)])
        elif e.get("loop", kind == "ambience"):
            to_wav(raw, a, 2 if stereo else 1)
            src = a
            if kind == "music":
                trim_edges(a, c, 2)
                src = c
            make_loop(src, b, LOOP_XFADE[kind])
        else:
            # Pièce non bouclée (victoire, défaite) : fondu final court.
            to_wav(raw, a, 2)
            d = duration(a)
            run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(a), "-af",
                 f"afade=t=in:d=0.01,afade=t=out:st={d - 1.5:.3f}:d=1.5",
                 "-c:a", "pcm_f32le", str(b)])
        gain = normalize(b, c, e)
        loop = bool(e.get("loop", kind == "ambience"))
        body = duration(c)
        if loop:
            pad(c, b, LOOP_PAD)
            c, b = b, c
        profile = kind if kind != "sfx" else ("sfx-stereo" if stereo else "sfx")
        folder = {"music": "music", "ambience": "ambience", "sfx": "sfx"}[kind]
        sizes = encode(c, OUT / folder / sid, profile)
        sounds[sid] = {
            "kind": kind,
            "base": f"{folder}/{sid}",
            "duration": round(duration(c), 3),
            "loop": loop,
            **({"loopStart": LOOP_PAD, "loopEnd": round(LOOP_PAD + body, 4)} if loop else {}),
            "channels": 2 if stereo else 1,
            "bytes": sizes,
            "gainDb": round(gain, 2),
        }
    manifest = {
        "version": 1,
        "source": "ElevenLabs (sound-generation, music) — généré pour Red Line",
        "formats": {"webm": 'audio/webm; codecs="opus"', "m4a": 'audio/mp4; codecs="mp4a.40.2"'},
        "sounds": dict(sorted(sounds.items())),
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    write_credits()
    tot_w = sum(s["bytes"]["webm"] for s in sounds.values())
    tot_m = sum(s["bytes"]["m4a"] for s in sounds.values())
    print(f"  total : Opus/WebM {tot_w / 1e6:.2f} Mo · AAC/M4A {tot_m / 1e6:.2f} Mo")


def write_credits() -> None:
    titles = {"music": "Musiques", "ambience": "Ambiances (boucles)", "sfx": "Effets"}
    lines = [
        "# Red Line — crédits audio",
        "",
        "Tous les sons et musiques de ce dossier ont été **générés pour Red Line avec ElevenLabs**",
        "(API `sound-generation` pour les effets et ambiances, API `music` pour les musiques), puis",
        "découpés, bouclés, normalisés (EBU R128) et encodés (Opus/WebM, AAC/M4A) par",
        "`tools/audio/build.py`. Aucune donnée personnelle n'a été transmise : seules les descriptions",
        "ci-dessous ont été envoyées. Descriptions complètes : `tools/audio/sounds.json`.",
        "",
    ]
    for kind in ("music", "ambience", "sfx"):
        lines += [f"## {titles[kind]}", ""]
        for e in SPEC[kind]:
            words = e["prompt"].replace("Instrumental only. ", "")
            short = words if len(words) <= 110 else words[:107].rsplit(" ", 1)[0] + "…"
            lines.append(f"- `{e['id']}` — {short}")
        lines.append("")
    (OUT / "CREDITS.md").write_text("\n".join(lines))


# ——— Contrôle ———


def decode(path: Path, channels: int):
    import numpy as np

    r = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path),
         "-f", "f32le", "-ac", str(channels), "-ar", str(RATE), "-"],
        capture_output=True, check=True,
    )
    return np.frombuffer(r.stdout, dtype=np.float32).reshape(-1, channels)


def weld(x, a: int, b: int, k: int = 2048):
    """
    Soudure de la jointure, comme le fait le client (apps/client/src/audio/weld.ts) : les k échantillons
    avant `loopEnd` sont fondus vers ceux qui précèdent `loopStart` (même musique, bruit de codec
    différent) ; la lecture passe alors de x[a-1] à x[a], continus dans le flux décodé.
    """
    import numpy as np

    y = x.copy()
    f = (np.arange(k, dtype=np.float32) + 1) / k
    y[b - k: b] = x[b - k: b] * (1 - f)[:, None] + x[a - k: a] * f[:, None]
    return y[a:b]


def junction_ratio(x) -> float:
    """
    Clic à la jointure : énergie de la dérivée seconde (hautes fréquences) dans ±2 ms autour de la
    jointure (fin → début), rapportée au 99e centile de la même mesure sur tout le fichier.
    Un clic donne un rapport ≫ 1 ; une jointure propre reste ≲ 1.
    """
    import numpy as np

    w = 96
    joined = np.concatenate([x[-4 * w:], x[: 4 * w]], axis=0)
    def hf(sig):
        d2 = np.diff(sig, n=2, axis=0)
        e = np.sqrt(np.convolve((d2 ** 2).mean(axis=1), np.ones(w) / w, mode="valid"))
        return e
    around = hf(joined)
    mid = len(around) // 2
    peak = around[mid - w: mid + w].max()
    ref = np.percentile(hf(x[: min(len(x), RATE * 30)]), 99)
    return float(peak / max(ref, 1e-9))


def cmd_check(only: list[str]) -> None:
    manifest = json.loads((OUT / "manifest.json").read_text())
    bad = 0
    print(f"{'son':22} {'durée':>7} {'LUFS':>7} {'dBTP':>6} {'jointure':>9} {'saut dB':>8} {'webm':>8} {'m4a':>8}")
    for sid, s in manifest["sounds"].items():
        if only and sid not in only:
            continue
        webm = OUT / f"{s['base']}.webm"
        m = loudness(webm)
        d = duration(webm)
        j = step = ""
        if s["loop"]:
            import numpy as np

            for fmt in ("webm", "m4a"):
                y = decode(OUT / f"{s['base']}.{fmt}", s["channels"])
                y = weld(y, round(s["loopStart"] * RATE), round(s["loopEnd"] * RATE))
                if fmt == "webm":
                    x = y
                elif junction_ratio(y) > 3:
                    bad += 1
                    print(f"  {sid} : clic à la jointure (m4a)")
            ratio = junction_ratio(x)
            # Saut de niveau à la jointure : RMS des 0,5 dernières s contre les 0,5 premières.
            rms = lambda y: 20 * np.log10(np.sqrt((y ** 2).mean()) + 1e-9)
            jump = rms(x[: RATE // 2]) - rms(x[-RATE // 2:])
            j = f"{ratio:.2f}"
            step = f"{jump:+.1f}"
            # Le saut de niveau n'a de sens que pour la musique (les ambiances sont irrégulières).
            if ratio > 3 or (s["kind"] == "music" and abs(jump) > 6):
                bad += 1
                j += " !"
        if m["input_tp"] > -0.5:
            bad += 1
        print(f"{sid:22} {d:7.2f} {m['input_i']:7.1f} {m['input_tp']:6.1f} {j:>9} {step:>8} "
              f"{s['bytes']['webm'] / 1024:7.0f}k {s['bytes']['m4a'] / 1024:7.0f}k")
    tot_w = sum(s["bytes"]["webm"] for s in manifest["sounds"].values())
    tot_m = sum(s["bytes"]["m4a"] for s in manifest["sounds"].values())
    print(f"total : Opus/WebM {tot_w / 1e6:.2f} Mo · AAC/M4A {tot_m / 1e6:.2f} Mo")
    if bad:
        raise SystemExit(f"{bad} problème(s) détecté(s)")


if __name__ == "__main__":
    if sys.argv[1:2] == ["credits"]:
        write_credits()
        sys.exit(0)
    if len(sys.argv) < 2 or sys.argv[1] not in ("fetch", "build", "check"):
        print(__doc__)
        sys.exit(1)
    only = sys.argv[2:]
    {"fetch": cmd_fetch, "build": cmd_build, "check": cmd_check}[sys.argv[1]](only)
