export async function enhanceFilm(context) {
  const {W, resize, onBackgroundSettled} = context;
  const random = seed => () => (seed = seed * 16807 % 2147483647) / 2147483647;
  let complete = true;
  const run = async (label, work) => {
    try {
      if (await work() === false) complete = false;
    } catch (error) {
      complete = false;
      console.warn(`${label} unavailable; the base film remains playable`, error);
    }
  };
  const cinemaMod = import("./cinema.js").then(module => ({module}), error => ({error}));
  const modelsMod = import("./models.js").then(module => ({module}), error => ({error}));
  const nature = import("./nature.js").then(module => ({module}), error => ({error}));
  const optimize = import("./optimize.js").then(module => ({module}), error => ({error}));
  // Phase 1: load hero airliner, PBR runway/grass/HDR off-scene while base scene plays smoothly,
  // then apply cinema + procedural models + nature + batching in one atomic step so shaders compile once.
  await run("World details", async () => {
    const {enhanceWorld} = await import("./details.js");
    return enhanceWorld({...context, rnd: random(11)});
  });
  await run("Cinematic pass", async () => {
    const {module, error} = await cinemaMod;
    if (error) throw error;
    W.cinema = module.enhanceCinema({...context, rnd: random(17)});
  });
  await run("Procedural models", async () => {
    const {module, error} = await modelsMod;
    if (error) throw error;
    return module.enhanceModels({...context, rnd: random(23), streamProps: false});
  });
  await run("Nature pass", async () => {
    const {module, error} = await nature;
    if (error) throw error;
    module.enhanceNature({...context, rnd: random(29)});
  });
  await run("Scene optimization", async () => {
    const {module, error} = await optimize;
    if (error) throw error;
    module.optimizeScene(context);
  });
  resize();

  // Phase 2: stream the 11 distant Poly Haven airfield props in small non-blocking batches, then patch shaders on idle.
  const idleSlice = () => new Promise(resolve => {
    if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve(), {timeout: 200});
    else setTimeout(resolve, 16);
  });
  (async () => {
    let propsOk = true;
    try {
      if (W.streamScannedProps) {
        const {ok, group} = await W.streamScannedProps();
        if (!ok) propsOk = false;
        await idleSlice();
        if (group) W.patchNatureSubtree?.(group);
      }
    } catch (error) {
      propsOk = false;
      console.warn("Model pass unavailable; the base film remains playable", error);
    }
    onBackgroundSettled?.(propsOk);
  })();

  return complete;
}
