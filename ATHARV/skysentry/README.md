# SkySentry in Motion — detail enhancement

This is an enhancement of the user's supplied `SkySentry in Motion.html`. The eight scenes, 100-second story, UI layout, timeline and risk/architecture explanations are retained. Camera shot 2 is widened slightly to keep the detailed aircraft fully in frame; detection formation spacing is increased to reduce overlap.

Added: a CC0 detailed airliner with animated fan assemblies and landing gear, scanned asphalt/grass materials, HDR environment lighting, runway rubber wear and patch seams, drainage, approach lighting, taxi signs, hold-short markings, ribbed hangars, terminal glazing, tower consoles and antennas, fence wire, parked vehicles, ground service equipment, sensor optics/cable/display, feathered geese and a drone gimbal.

Cinematic pass (`dist/cinema.js`, loaded after `details.js`): physically based sky captured to a cube map, sun lens flare, 2048 px shadows, bloom, colour grade with vignette, grain and slight chromatic aberration, and SMAA. Adds painted cumulus clouds, wind-animated grass near close-up cameras, patchwork farmland, a hillside village, farmsteads with barns and silos, a water tower, a perimeter power line, PAPI lights, an ILS localizer and glideslope mast, distance-remaining boards, a rotating airport beacon, takeoff-roll tyre dust, drifting pollen and aircraft landing-light glow. Runway edge lights are resized to small domes. Quality adapts through render resolution, bloom and SMAA on slow machines. Three.js add-ons are served locally. Ambient occlusion and depth of field are disabled to avoid extra scene renders.

Model pass (`dist/models.js`, loaded after `cinema.js`): eleven scanned CC0 props from Poly Haven under `dist/assets/models/` (shrubs, boulders, apron floodlights, security cameras, utility cabinets, rooftop air-conditioning, jersey barriers, ground power units, LPG tanks, fire hydrants), instanced around the field. Rebuilds the geese (shaped body, outstretched black neck, white chinstrap and undertail, two-part wings that bend at the wrist), replaces the parked mini-airliners with high-wing single-engine light aircraft with chocks, and adds a weather station and VHF antennas on the tower roof. The glideslope mast sits north of the runway so it stays clear of the shot 2 camera.

Nature pass (`dist/nature.js`, loaded after `models.js`): one shared wind field (direction matches the windsock and cloud drift) drives up to 47,000 instanced grass blades near the camera positions, with gusts that ripple across the field, swaying tree crowns, bushes and scanned shrubs, a waving US flag on the terminal forecourt, and a windsock that fills and droops with the gusts. Moving cloud shadows dim direct sunlight on every lit surface.

Hosting note: artifact hosting does not serve .glb/.bin/.hdr, so the loaders read `*.gltf.json` (glTF with embedded buffers) and `derelict_airfield_01_1k.hdr.json` (base64). The original binary files are kept for reference and checksums.

Run locally with `python3 -m http.server 8765 --bind 127.0.0.1 --directory dist`, then open http://127.0.0.1:8765.

External 3D assets are bundled under `dist/assets`; attribution, license links and checksums are in `ASSET_CREDITS.json`. Three.js r180 is bundled under `dist/vendor` with its MIT license. Google Fonts has system fallbacks.

Prototype animation only. Readings, alerts, reports and charts are simulated, not a live aviation safety service. Content and technical claims in the original film are retained from the supplied brief and are not independently validated here.

QA: desktop browser inspection of all eight scene compositions, 390px mobile width check, timeline, pause/play, fullscreen, console diagnostics and JavaScript syntax checks. URL parameters `scene` (1–8), `time` (seconds into scene), and `paused=1` support reproducible frame inspection.

Performance pass: simplified scanned meshes retain 12–35% of their original triangles and keep original textures. Shared materials and static geometry batching reduce draw calls. Grass uses fewer segments and is hidden for high aerial shots. Paused playback does not render continuously. Internal resolution is capped and adapts to slow frames.
