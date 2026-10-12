// Runs in CI right after `npx cap add android`.
// 1) copies our native SSH plugin (Java) into the generated Android project
// 2) adds the JSch SSH library dependency
// 3) sets minSdk 26 (JSch needs java.nio) and disables auto-backup (credentials are Keystore-encrypted)
import fs from 'node:fs';
import path from 'node:path';

const APP_ID_PATH = 'com/vikki/mhcloud';
const JSCH = 'com.github.mwiede:jsch:0.2.21';

const androidDir = path.resolve('android');
if (!fs.existsSync(androidDir)) {
  console.error('android/ folder not found. Run "npx cap add android" first.');
  process.exit(1);
}

// 1) native java files
const javaDir = path.join(androidDir, 'app/src/main/java', APP_ID_PATH);
fs.mkdirSync(javaDir, { recursive: true });
for (const f of fs.readdirSync('native/android')) {
  if (!f.endsWith('.java')) continue;
  fs.copyFileSync(path.join('native/android', f), path.join(javaDir, f));
  console.log('installed ' + f);
}

// 2) gradle dependency
const gradlePath = path.join(androidDir, 'app/build.gradle');
let gradle = fs.readFileSync(gradlePath, 'utf8');
if (!gradle.includes('com.github.mwiede')) {
  const re = /dependencies\s*\{/;
  if (!re.test(gradle)) {
    console.error('Could not find dependencies block in app/build.gradle');
    process.exit(1);
  }
  gradle = gradle.replace(re, (m) => m + "\n    implementation '" + JSCH + "'");
  fs.writeFileSync(gradlePath, gradle);
  console.log('added ' + JSCH);
}

// 3a) minSdk
const varsPath = path.join(androidDir, 'variables.gradle');
let vars = fs.readFileSync(varsPath, 'utf8');
vars = vars.replace(/minSdkVersion\s*=\s*\d+/, 'minSdkVersion = 26');
fs.writeFileSync(varsPath, vars);
console.log('minSdkVersion set to 26');

// 3b) manifest
const manifestPath = path.join(androidDir, 'app/src/main/AndroidManifest.xml');
let manifest = fs.readFileSync(manifestPath, 'utf8');
manifest = manifest.replace('android:allowBackup="true"', 'android:allowBackup="false"');
fs.writeFileSync(manifestPath, manifest);
console.log('allowBackup disabled');
