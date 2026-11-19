const { hasCode } = require("./access");

// Match a scalar airport only. Mongo field equality alone also matches array members.
function airportFilter(airport) {
  if (!hasCode(airport)) throw new Error("authorized airport required for history");
  return { airport, $expr: { $eq: ["$airport", airport] } };
}

function hourlyPipeline(airport, cutoff, type) {
  return [
    { $match: { ...airportFilter(airport), time: { $gt: cutoff }, type: type || { $type: "string" } } },
    { $group: { _id: { hour: { $dateTrunc: { date: "$time", unit: "hour" } }, type: "$type" }, events: { $sum: 1 }, total_objects: { $sum: "$object_count" } } },
    { $project: { _id: 0, hour: "$_id.hour", type: "$_id.type", events: 1, total_objects: 1 } },
    { $sort: { hour: 1, type: 1 } },
  ];
}

module.exports = { airportFilter, hourlyPipeline };
