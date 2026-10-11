// Shreyansh's immediate alert + parallel report/voice pipeline, deployed inside PRANAV.
const { createPipeline } = require('./ai-voice/pipeline');
const { buildAlertText } = require('./ai-voice/voice');
module.exports = { ...createPipeline(), alertSentence: buildAlertText, createPipeline };
