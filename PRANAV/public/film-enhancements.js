export async function enhanceFilm(context) {
  const {W, resize} = context;
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
  // Fetch these modules now; don't run nature or batching until the scene is assembled.
  const nature = import("./nature.js").then(module => ({module}), error => ({error}));
  const optimize = import("./optimize.js").then(module => ({module}), error => ({error}));
  await Promise.all([
    run("World details", async () => {
      const {enhanceWorld} = await import("./details.js");
      return enhanceWorld({...context, rnd: random(11)});
    }),
    run("Cinematic pass", async () => {
      const {enhanceCinema} = await import("./cinema.js");
      W.cinema = enhanceCinema({...context, rnd: random(17)});
      resize();
    }),
    run("Model pass", async () => {
      const {enhanceModels} = await import("./models.js");
      return enhanceModels({...context, rnd: random(23)});
    })
  ]);
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
  return complete;
}
