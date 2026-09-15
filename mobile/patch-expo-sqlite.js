const fs = require("fs");
const path = require("path");

if (process.env.EAS_BUILD_PLATFORM !== "android") {
  console.log("SENTINEL SQLite patch: skipped (not Android)");
  process.exit(0);
}

const gradlePath = path.join(
  process.cwd(),
  "node_modules",
  "expo-sqlite",
  "android",
  "build.gradle"
);

const sqliteZip = path.join(
  process.cwd(),
  "sqlite-downloads",
  "sqlite-amalgamation-3450300.zip"
);

if (!fs.existsSync(gradlePath)) {
  throw new Error(`expo-sqlite build.gradle not found: ${gradlePath}`);
}

if (!fs.existsSync(sqliteZip)) {
  throw new Error(`Bundled SQLite ZIP not found: ${sqliteZip}`);
}

let gradle = fs.readFileSync(gradlePath, "utf8");

const oldRemote =
  'src("https://www.sqlite.org/2024/sqlite-amalgamation-${SQLITE_VERSION}.zip")';

const oldLocal =
  'src(new File(project.projectDir, "../../../sqlite-downloads/sqlite-amalgamation-${SQLITE_VERSION}.zip"))';

const newLocal =
  'src(new File(project.projectDir, "../../../sqlite-downloads/sqlite-amalgamation-${SQLITE_VERSION}.zip").toURI().toURL())';

if (gradle.includes(newLocal)) {
  console.log("SENTINEL SQLite patch: already applied");
  process.exit(0);
}

if (gradle.includes(oldLocal)) {
  gradle = gradle.replace(oldLocal, newLocal);
} else if (gradle.includes(oldRemote)) {
  gradle = gradle.replace(oldRemote, newLocal);
} else {
  throw new Error(
    "Expected expo-sqlite SQLite download source was not found. Refusing to modify the file."
  );
}

fs.writeFileSync(gradlePath, gradle);

console.log("==============================================");
console.log("SENTINEL SQLite patch: SUCCESS");
console.log("Using bundled SQLite ZIP as a file URL");
console.log(sqliteZip);
console.log("==============================================");
