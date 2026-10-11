"""SkySentry testbench: a standalone Streamlit app, separate from the SkySentry app.

    .venv/bin/streamlit run testbench/app.py --server.port 8502

Imports only the shared benchmark/model code in benchmarks/bench (never SkySentry app code).
The field-set holdout half is never offered here; it runs only via a confirmed "final run".
"""

import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import pandas as pd
import streamlit as st

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "benchmarks"))
from bench.common import BENCH, MODELS, VERSIONS, read_results  # noqa: E402
from bench.stats import significant  # noqa: E402

st.set_page_config(page_title="SkySentry Testbench", page_icon="🛫", layout="wide")

BLUE, ORANGE, AQUA, MUTED = "#2a78d6", "#eb6834", "#1baf7a", "#898781"
CLS_NAME = {0: "bird", 1: "drone"}
CLS_COLOR = {0: (42, 120, 214), 1: (235, 104, 52)}


# ------------------------------------------------------------------ shared helpers

def version_configs():
    out = {}
    for p in sorted(VERSIONS.glob("v*.json"), key=lambda p: int(p.stem[1:]) if p.stem[1:].isdigit() else 999):
        try:
            out[p.stem] = json.loads(p.read_text())
        except Exception:
            pass
    return out


@st.cache_resource(show_spinner="Loading YOLO model…")
def yolo(weights):
    from ultralytics import YOLO
    return YOLO(str(ROOT / weights))


@st.cache_resource(show_spinner="Loading audio model…")
def audio_model(weights):
    from bench.audio import AudioDetector
    from bench.common import pick_device
    return AudioDetector(str(ROOT / weights), pick_device())


def device():
    from bench.common import pick_device
    return pick_device()


def draw(img_bgr, boxes, conf):
    import cv2
    out = img_bgr.copy()
    h, w = out.shape[:2]
    for b in boxes:
        if b["score"] < conf:
            continue
        c = CLS_COLOR[b["cls"]][::-1]
        p1, p2 = (int(b["x1"] * w), int(b["y1"] * h)), (int(b["x2"] * w), int(b["y2"] * h))
        cv2.rectangle(out, p1, p2, c, max(2, w // 400))
        label = f"{CLS_NAME[b['cls']]} {b['score']:.2f}"
        cv2.putText(out, label, (p1[0], max(14, p1[1] - 6)), cv2.FONT_HERSHEY_SIMPLEX, max(0.5, w / 1400), c, 2)
    return out


def detect(model, img_bgr, imgsz):
    t0 = time.perf_counter()
    r = model.predict(img_bgr, imgsz=imgsz, conf=0.01, device=device(), verbose=False)[0]
    ms = (time.perf_counter() - t0) * 1000
    boxes = [{"cls": int(c), "score": float(s), "x1": float(x1), "y1": float(y1), "x2": float(x2), "y2": float(y2)}
             for (x1, y1, x2, y2), c, s in zip(r.boxes.xyxyn.cpu().numpy(), r.boxes.cls.cpu().numpy(), r.boxes.conf.cpu().numpy())]
    return boxes, ms


def test_set_images(include_field=True):
    """Frozen visual test items, excluding the holdout half."""
    try:
        from bench import manifest
        items, _ = manifest.visual_items(manifest.load(), final=False)
        return items
    except SystemExit:
        return pd.DataFrame()


def pick_versions(key, n=2):
    cfgs = version_configs()
    if not cfgs:
        st.warning("No model versions yet: add models/versions/v0.json.")
        st.stop()
    names = list(cfgs)
    cols = st.columns(2)
    a = cols[0].selectbox("Model version", names, index=len(names) - 1, key=f"{key}_a")
    b = cols[1].selectbox("Compare with (optional)", ["—"] + names, key=f"{key}_b") if n == 2 else "—"
    chosen = [a] + ([b] if b != "—" and b != a else [])
    return {v: cfgs[v] for v in chosen}


# ------------------------------------------------------------------ a) Image / video

def page_image():
    st.title("Image / Video Test")
    vs = pick_versions("img")
    c1, c2 = st.columns(2)
    defaults = next(iter(vs.values()))
    conf = c1.slider("Confidence threshold", 0.05, 0.95, float(defaults.get("visual_conf", 0.25)), 0.05)
    imgsz = c2.select_slider("Image size (imgsz)", [320, 480, 640, 960, 1280], value=int(defaults.get("imgsz", 640)))
    src = st.radio("Source", ["Upload image(s)", "Upload video", "Pick from test sets"], horizontal=True)
    import cv2
    images = []
    if src == "Upload image(s)":
        for f in st.file_uploader("Images", type=["jpg", "jpeg", "png"], accept_multiple_files=True) or []:
            images.append((f.name, cv2.imdecode(np.frombuffer(f.read(), np.uint8), cv2.IMREAD_COLOR)))
    elif src == "Pick from test sets":
        items = test_set_images()
        if items.empty:
            st.info("Test sets aren't frozen yet.")
            return
        tier = st.selectbox("Tier", sorted(items.tier.unique()))
        sub = items[items.tier == tier]
        chosen = st.multiselect("Images", sub.item_id.tolist(), default=sub.item_id.tolist()[:4], max_selections=12)
        for iid in chosen:
            images.append((iid, cv2.imread(sub.set_index("item_id").path[iid])))
    else:
        video_page(vs, conf, imgsz)
        return
    for name, img in images:
        st.markdown(f"**{name}**")
        cols = st.columns(len(vs))
        for col, (v, cfg) in zip(cols, vs.items()):
            if not cfg.get("visual_weights"):
                col.info(f"{v} has no visual model")
                continue
            boxes, ms = detect(yolo(cfg["visual_weights"]), img, imgsz)
            kept = [b for b in boxes if b["score"] >= conf]
            col.image(draw(img, boxes, conf)[:, :, ::-1], use_container_width=True)
            col.caption(f"{v}: {len(kept)} detections · {ms:.0f} ms · " +
                        (", ".join(f"{CLS_NAME[b['cls']]} {b['score']:.2f}" for b in sorted(kept, key=lambda b: -b["score"])[:6]) or "none"))


def video_page(vs, conf, imgsz):
    import cv2
    import plotly.graph_objects as go
    f = st.file_uploader("Video", type=["mp4", "mov", "m4v", "avi"])
    every = st.slider("Analyse every Nth frame", 1, 15, 5)
    rotate = st.selectbox("Rotate (phone videos are often stored sideways)", ["none", "90° clockwise", "90° counter-clockwise", "180°"])
    if not f:
        return
    tmp = Path(tempfile.mkdtemp()) / f.name
    tmp.write_bytes(f.read())
    rot = {"90° clockwise": cv2.ROTATE_90_CLOCKWISE, "90° counter-clockwise": cv2.ROTATE_90_COUNTERCLOCKWISE, "180°": cv2.ROTATE_180}.get(rotate)
    cap = cv2.VideoCapture(str(tmp))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    frames, idx = [], 0
    while True:
        ok, fr = cap.read()
        if not ok:
            break
        if idx % every == 0:
            frames.append((idx / fps, cv2.rotate(fr, rot) if rot is not None else fr))
        idx += 1
    st.caption(f"{idx} frames at {fps:.1f} fps; analysing {len(frames)}")
    fig = go.Figure()
    results = {}
    for (v, cfg), color in zip(vs.items(), (BLUE, ORANGE)):
        model = yolo(cfg["visual_weights"])
        prog = st.progress(0.0, text=f"{v}: analysing frames")
        rows = []
        for k, (t, fr) in enumerate(frames):
            boxes, ms = detect(model, fr, imgsz)
            rows.append({"t": t, "bird": max([b["score"] for b in boxes if b["cls"] == 0], default=0),
                         "drone": max([b["score"] for b in boxes if b["cls"] == 1], default=0), "ms": ms, "boxes": boxes})
            prog.progress((k + 1) / len(frames), text=f"{v}: frame {k + 1}/{len(frames)}")
        prog.empty()
        df = pd.DataFrame(rows)
        results[v] = df
        fig.add_scatter(x=df.t, y=df.drone, name=f"{v} drone", line={"color": color, "width": 2})
        fig.add_scatter(x=df.t, y=df.bird, name=f"{v} bird", line={"color": color, "width": 2, "dash": "dot"})
    fig.add_hline(y=conf, line_dash="dash", line_color=MUTED, annotation_text="threshold")
    fig.update_layout(title="Per-frame max confidence", xaxis_title="time (s)", yaxis_title="confidence", yaxis_range=[0, 1],
                      height=360, hovermode="x unified", margin={"t": 50, "b": 40})
    st.plotly_chart(fig, use_container_width=True)
    k = st.slider("Frame", 0, len(frames) - 1, 0)
    cols = st.columns(len(results))
    for col, (v, df) in zip(cols, results.items()):
        col.image(draw(frames[k][1], df.boxes.iloc[k], conf)[:, :, ::-1], caption=f"{v} at {frames[k][0]:.1f}s · {df.ms.iloc[k]:.0f} ms",
                  use_container_width=True)


# ------------------------------------------------------------------ b) Audio

def page_audio():
    st.title("Audio Test")
    from bench import audio as A
    import plotly.graph_objects as go
    vs = {v: c for v, c in pick_versions("aud").items() if c.get("audio_weights")}
    if not vs:
        st.info("The selected version(s) have no audio model.")
        return
    defaults = next(iter(vs.values()))
    c1, c2 = st.columns(2)
    thr = c1.slider("Drone threshold", 0.05, 0.95, float(defaults.get("audio_threshold", 0.5)), 0.05)
    k = c2.select_slider("Consecutive windows required", [1, 2, 3], value=int(defaults.get("audio_min_consecutive", 1)))
    src = st.radio("Source", ["Upload", "Record"], horizontal=True)
    data = st.file_uploader("Audio file", type=["wav", "mp3", "m4a", "flac", "ogg", "mp4"]) if src == "Upload" else st.audio_input("Record")
    if not data:
        return
    tmp = Path(tempfile.mkdtemp()) / (getattr(data, "name", None) or "rec.wav")
    tmp.write_bytes(data.getvalue())
    y = A.load_audio(str(tmp))
    with st.expander("Mix in noise live (robustness demo)"):
        noise_dir = ROOT / "data" / "esc50_noise"
        kinds = sorted(p.name for p in noise_dir.iterdir()) if noise_dir.exists() else []
        if kinds:
            nt = st.selectbox("Noise", ["none"] + kinds)
            snr = st.slider("SNR (dB)", -10, 20, 5)
            if nt != "none":
                files = sorted((noise_dir / nt).glob("*.wav"))
                y = A.mix_at_snr(y, A.load_audio(str(files[0])), snr, np.random.default_rng(0))
        else:
            st.caption("ESC-50 noise clips appear here once the stress set is built.")
    st.audio(y, sample_rate=A.SR)
    t = np.arange(len(y)) / A.SR
    step = max(1, len(y) // 4000)
    st.plotly_chart(go.Figure(go.Scatter(x=t[::step], y=y[::step], line={"color": MUTED, "width": 1})).update_layout(
        title="Waveform", height=180, margin={"t": 40, "b": 20}, xaxis_title="time (s)"), use_container_width=True)
    import librosa
    S = librosa.power_to_db(librosa.feature.melspectrogram(y=y, sr=A.SR, n_mels=64), ref=np.max)
    st.plotly_chart(go.Figure(go.Heatmap(z=S, x=np.arange(S.shape[1]) * 512 / A.SR, colorscale="Blues", showscale=False)).update_layout(
        title="Mel spectrogram", height=240, margin={"t": 40, "b": 20}, xaxis_title="time (s)", yaxis_title="mel band"), use_container_width=True)
    fig = go.Figure()
    verdicts = []
    for (v, cfg), color in zip(vs.items(), (BLUE, ORANGE)):
        probs, starts = audio_model(cfg["audio_weights"]).window_probs(y)
        fig.add_scatter(x=starts + A.WIN_S / 2, y=probs, name=v, mode="lines+markers", line={"color": color, "width": 2, "shape": "hv"})
        ev = A.detect_events(probs, thr, k)
        verdicts.append((v, ev, float(probs.max())))
    fig.add_hline(y=thr, line_dash="dash", line_color=MUTED, annotation_text=f"threshold {thr}")
    fig.update_layout(title="Drone probability per 1 s window", yaxis_range=[0, 1], height=300, xaxis_title="time (s)",
                      hovermode="x unified", margin={"t": 40, "b": 20})
    st.plotly_chart(fig, use_container_width=True)
    for v, ev, mx in verdicts:
        (st.error if ev else st.success)(f"**{v}: {'DRONE DETECTED' if ev else 'no drone'}** — {ev} alarm event(s), max p = {mx:.2f}")


# ------------------------------------------------------------------ c) Dashboard

def page_dashboard():
    st.title("Benchmark Dashboard")
    rows = read_results()
    if not rows:
        st.info("No benchmark runs yet.")
        return
    df = pd.DataFrame(rows)
    runs = df[df.row_type == "run"].copy()
    dec = df[df.row_type == "decision"].set_index("version")
    runs["decision"] = runs.version.map(dec.decision).fillna("pending")
    show = ["version", "decision", "timestamp_utc", "hypothesis", "visual_drone_recall", "visual_fa_rate", "audio_drone_recall", "audio_fa_per_hour", "git_commit"]
    f = st.multiselect("Filter decisions", ["keep", "revert", "pending"], default=["keep", "revert", "pending"])
    st.dataframe(runs[runs.decision.isin(f)][show], use_container_width=True, hide_index=True)

    st.subheader("Version vs version")
    names = runs.version.tolist()
    c1, c2 = st.columns(2)
    a = c1.selectbox("Version A", names, index=0)
    b = c2.selectbox("Version B", names, index=len(names) - 1)
    ma = json.loads(runs.set_index("version").metrics_json[a])
    mb = json.loads(runs.set_index("version").metrics_json[b])
    lines = []
    for mod in sorted(set(ma) | set(mb)):
        for key in sorted(set(ma.get(mod, {})) | set(mb.get(mod, {}))):
            va, vb = ma.get(mod, {}).get(key), mb.get(mod, {}).get(key)
            if not (isinstance(va, dict) and isinstance(vb, dict)):
                continue
            lines.append({"metric": f"{mod}.{key}", a: round(va["value"], 4), b: round(vb["value"], 4),
                          "delta": round(vb["value"] - va["value"], 4), "significance": significant(vb, va)})
    st.dataframe(pd.DataFrame(lines), use_container_width=True, hide_index=True, height=420)

    st.subheader("Charts")
    charts = sorted((BENCH / "charts").glob("*.png")) if (BENCH / "charts").exists() else []
    for c in charts:
        st.image(str(c), caption=c.stem, use_container_width=True)
    st.subheader("Reports")
    for v in names:
        p = BENCH / v / "report.html"
        if p.exists():
            st.download_button(f"{v} report.html", p.read_bytes(), file_name=f"{v}_report.html", mime="text/html", key=f"rep_{v}")


# ------------------------------------------------------------------ d) Error explorer

def page_errors():
    st.title("Error Explorer")
    versions = [p.parent.parent.name for p in sorted(BENCH.glob("v*/errors/index.json"))]
    if not versions:
        st.info("No error galleries yet.")
        return
    v = st.selectbox("Version", versions, index=len(versions) - 1)
    idx = json.loads((BENCH / v / "errors" / "index.json").read_text())
    rows = [{**e, "modality": "visual"} for e in idx["visual"]] + [{**e, "modality": "audio"} for e in idx["audio"]]
    df = pd.DataFrame(rows)
    if df.empty:
        st.info("No errors recorded for this version.")
        return
    c = st.columns(5)
    kind = c[0].multiselect("Type", ["fp", "fn"], default=["fp", "fn"])
    mod = c[1].multiselect("Model", ["visual", "audio"], default=["visual", "audio"])
    filt = df[df.kind.isin(kind) & df.modality.isin(mod)]
    for col, field in zip(c[2:], ("size", "condition", "noise_type")):
        if field in filt and filt[field].notna().any():
            vals = col.multiselect(field, sorted(filt[field].dropna().unique()))
            if vals:
                filt = filt[filt[field].isin(vals)]
    st.caption(f"{len(filt)} items")
    cfg = version_configs().get(v, {})
    for i in range(0, len(filt), 4):
        cols = st.columns(4)
        for col, (_, e) in zip(cols, filt.iloc[i:i + 4].iterrows()):
            col.image(str(BENCH / v / "errors" / e.file), use_container_width=True)
            col.caption(f"{e.kind.upper()} · {e.get('class') or e.get('tier')} · {e.get('score', e.get('prob'))}")
            if col.button("Rerun live", key=f"rr_{v}_{e.file}"):
                st.session_state["rerun"] = e.to_dict()
    if "rerun" in st.session_state:
        rerun_panel(st.session_state["rerun"], cfg)


def rerun_panel(e, cfg):
    st.divider()
    st.subheader(f"Rerun: {e['item_id']}")
    if e["modality"] == "visual" and cfg.get("visual_weights"):
        import cv2
        items = test_set_images().set_index("item_id")
        if e["item_id"] not in items.index:
            st.warning("Item not in the current (non-holdout) test sets.")
            return
        conf = st.slider("Confidence", 0.05, 0.95, float(cfg.get("visual_conf", 0.25)), 0.05, key="rr_conf")
        imgsz = st.select_slider("imgsz", [320, 480, 640, 960, 1280], value=int(cfg.get("imgsz", 640)), key="rr_sz")
        img = cv2.imread(items.path[e["item_id"]])
        boxes, ms = detect(yolo(cfg["visual_weights"]), img, imgsz)
        st.image(draw(img, boxes, conf)[:, :, ::-1], caption=f"{ms:.0f} ms")
    elif e["modality"] == "audio" and cfg.get("audio_weights"):
        from bench import audio as A
        from bench import manifest
        items = manifest.audio_items(manifest.load()).set_index("item_id")
        thr = st.slider("Threshold", 0.05, 0.95, float(cfg.get("audio_threshold", 0.5)), 0.05, key="rr_thr")
        k = st.select_slider("Consecutive windows", [1, 2, 3], value=int(cfg.get("audio_min_consecutive", 1)), key="rr_k")
        y = A.load_audio(items.path[e["item_id"]])
        probs, starts = audio_model(cfg["audio_weights"]).window_probs(y)
        st.line_chart(pd.DataFrame({"p(drone)": probs, "threshold": thr}, index=starts))
        ev = A.detect_events(probs, thr, k)
        st.write(f"**{'DRONE' if ev else 'no drone'}** ({ev} events)")


# ------------------------------------------------------------------ e) Run benchmark

def page_run():
    st.title("Run Benchmark")
    cfgs = version_configs()
    done = {r["version"] for r in read_results() if r["row_type"] == "run"}
    todo = [v for v in cfgs if v not in done]
    if not todo:
        st.info("Every configured version already has a finished run. Add models/versions/vN.json for the next change.")
        return
    v = st.selectbox("Version to benchmark", todo)
    st.json(cfgs[v], expanded=False)
    hyp = st.text_area("Hypothesis (written BEFORE running: what should change, and why?)")
    final = st.checkbox("Final run (include the field-set holdout half)")
    confirm = st.checkbox("I confirm Vivan said \"final run\".") if final else True
    if st.button("Run benchmark", type="primary", disabled=not hyp.strip() or not confirm):
        cmd = [str(ROOT / ".venv" / "bin" / "python"), str(ROOT / "benchmarks" / "benchmark.py"), "--version", v, "--hypothesis", hyp]
        if final:
            cmd.append("--final")
        box = st.empty()
        lines = []
        proc = subprocess.Popen(cmd, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        with st.spinner(f"Benchmarking {v}…"):
            for line in proc.stdout:
                lines.append(line.rstrip())
                box.code("\n".join(lines[-40:]))
        proc.wait()
        (st.success if proc.returncode == 0 else st.error)(f"Exit code {proc.returncode}")
        if proc.returncode == 0:
            subprocess.run([str(ROOT / ".venv" / "bin" / "python"), str(ROOT / "benchmarks" / "make_charts.py")], cwd=ROOT)
            subprocess.run([str(ROOT / ".venv" / "bin" / "python"), str(ROOT / "benchmarks" / "report.py"), "--version", v], cwd=ROOT)
            st.info("Charts and report regenerated. Record keep/revert with benchmarks/decide.py.")


pg = st.navigation([st.Page(page_image, title="Image / Video Test", icon="🖼️", default=True),
                    st.Page(page_audio, title="Audio Test", icon="🔊"),
                    st.Page(page_dashboard, title="Benchmark Dashboard", icon="📊"),
                    st.Page(page_errors, title="Error Explorer", icon="🔍"),
                    st.Page(page_run, title="Run Benchmark", icon="▶️")])
st.sidebar.markdown("**SkySentry Testbench**  \nStandalone; separate from the SkySentry app.")
pg.run()
