// Run after `tauri android init`. Fixes the status-bar / navigation-bar overlap natively:
// the Activity pads its content view by the system-bar, cutout and keyboard insets, so the WebView
// (and the sticky header inside it) never draws under the status bar, on every Android version
// (Android 15 forces edge-to-edge, so this cannot rely on the old fitsSystemWindows behaviour).
// Also keeps hardware acceleration on and enables large heap. Idempotent.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = join(root, "src-tauri/gen/android/app/src/main");
const manifest = join(app, "AndroidManifest.xml");
if (!existsSync(manifest)) { console.error("✗ run `tauri android init` first"); process.exit(1); }

const kt = execSync(`find "${app}/java" -name MainActivity.kt`).toString().trim().split("\n")[0];
if (!kt) { console.error("✗ MainActivity.kt not found"); process.exit(1); }
const pkg = /^package\s+([\w.]+)/m.exec(readFileSync(kt, "utf8"))[1];
writeFileSync(kt, `package ${pkg}

import android.os.Bundle
import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    WindowCompat.setDecorFitsSystemWindows(window, false)
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
      val b = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
      )
      v.setPadding(b.left, b.top, b.right, b.bottom)
      WindowInsetsCompat.CONSUMED
    }
    ViewCompat.requestApplyInsets(content)
  }
}
`);
let m = readFileSync(manifest, "utf8");
if (!m.includes("android:largeHeap")) m = m.replace("<application", '<application android:largeHeap="true"');
if (!m.includes("android:hardwareAccelerated")) m = m.replace("<activity", '<activity android:hardwareAccelerated="true"');
writeFileSync(manifest, m);
console.log("✓ insets + manifest patched:", kt);
