const { build, buildSync } = require("esbuild");
const path = require("path");
const fs = require("fs");
// const fse = require('fs-extra');
const configAll = require('./build-config');


(async () => {
  try {
    let buildEvn = process.env.NODE_ENV
    let config = buildEvn == "production" ? configAll.build : configAll.build

    if (buildEvn !== "production") {
      config = configAll.dev
    }

    const timerStart = Date.now();
    fs.rmSync(path.dirname(config.outfile), { recursive: true, force: true });
    // fse.copySync("./assets", path.join(path.dirname(config.outfile), "assets"), { overwrite: true });
    // fs.copyFileSync("./index.html", path.join(path.dirname(config.outfile), "index.html"));
    // fs.copyFileSync(buildEvn == "production" ? "./index.html" : "./indexDebug.html", path.join(path.dirname(config.outfile), "index.html"));

    // config.incremental = false;
    await buildSync(config);
    const bodyText = fs.readFileSync(config.outfile);
    const headerText = fs.readFileSync('./header.txt').toString();
    fs.writeFileSync(config.outfile, `${headerText}\n${bodyText}`);
    const timerEnd = Date.now();
    console.log(`🔨 Built in ${timerEnd - timerStart}ms.`)
    process.exit(0);
  } catch (e) {
    console.error(e);
  }
})()
