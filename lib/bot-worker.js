"use strict";

const {parentPort} = require("node:worker_threads");
const {chooseMove} = require("./engine");

parentPort.on("message", ({id, args}) => {
  try {
    parentPort.postMessage({id,move:chooseMove(...args)});
  } catch {
    parentPort.postMessage({id,move:null});
  }
});
