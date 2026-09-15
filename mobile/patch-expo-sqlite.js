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

const remoteLine =
  'src("https://www.sqlite.org/2024/sqlite-amalgamation-${SQLITE_VERSION}.zip")';

const localLine =
  'src(new File(project.projectDir, "../../../sqlite-downloads/sqlite-amalgamation-${SQLITE_VERSION}.zip"))';

if (gradle.includes(localLine)) {
  console.log("SENTINEL SQLite patch: already applied");
  process.exit(0);
}

if (!gradle.includes(remoteLine)) {
  throw new Error(
    "Expected expo-sqlite SQLite download line was not found. Refusing to modify the file."
  );
}

gradle = gradle.replace(remoteLine, localLine);

fs.writeFileSync(gradlePath, gradle);

console.log("==============================================");
console.log("SENTINEL SQLite patch: SUCCESS");
console.log("Using bundled SQLite ZIP instead of sqlite.org");
console.log(sqliteZip);
console.log("==============================================");
