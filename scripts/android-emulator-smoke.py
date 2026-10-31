#!/usr/bin/env python3
"""Smoke-test an APK on a disposable, already-running Android emulator."""

import argparse
import http.server
import re
import subprocess
import threading
import time
import xml.etree.ElementTree as ET

PACKAGE = "id.adiputera.airrest"
MARKER = "AIRREST_ANDROID_SMOKE_OK"


def adb(*args):
    result = subprocess.run(["adb", *args], capture_output=True, text=True, timeout=90)
    if result.returncode:
        raise RuntimeError(f"adb {' '.join(args)} failed: {result.stderr or result.stdout}")
    return result.stdout


def hierarchy():
    path = "/data/local/tmp/airrest-smoke.xml"
    for attempt in range(5):
        try:
            adb("shell", "uiautomator", "dump", path)
            xml_str = adb("shell", "cat", path)
            if "<hierarchy" in xml_str:
                return ET.fromstring(xml_str)
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError("Failed to dump and read UI hierarchy after 5 attempts")


def wait_for(predicate, label, timeout=120):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        root = hierarchy()
        value = predicate(root)
        if value is not None:
            return value
        time.sleep(1)
    raise RuntimeError(f"Timed out waiting for {label}")


def find_text(root, text):
    return next((node for node in root.iter("node") if node.get("text") == text), None)


def tap(node):
    bounds = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", node.get("bounds", ""))
    if not bounds:
        raise RuntimeError("Control has no usable bounds")
    x1, y1, x2, y2 = map(int, bounds.groups())
    if x1 == x2 or y1 == y2:
        raise RuntimeError("Control is outside the visible viewport")
    adb("shell", "input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2))


class Fixture(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = ('{"marker":"' + MARKER + '"}').encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", help="APK for the running disposable emulator")
    parser.add_argument("--skip-install", action="store_true", help="use the APK already installed on the emulator")
    args = parser.parse_args()

    if not adb("get-serialno").strip().startswith("emulator-"):
        raise RuntimeError("This smoke test requires a disposable Android emulator")

    deadline = time.monotonic() + 180
    while adb("shell", "getprop", "sys.boot_completed").strip() != "1":
        if time.monotonic() >= deadline:
            raise RuntimeError("Emulator did not finish booting")
        time.sleep(2)
    print("Emulator booted", flush=True)

    server = http.server.HTTPServer(("127.0.0.1", 0), Fixture)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        if not args.skip_install:
            print("Installing APK", flush=True)
            adb("install", "-r", args.apk)
        adb("shell", "am", "force-stop", PACKAGE)
        adb("shell", "am", "start", "-n", PACKAGE + "/.MainActivity")
        def initial_control(root):
            prompt = find_text(root, "Use Offline Storage")
            return prompt if prompt is not None else find_text(root, "Send")

        first = wait_for(initial_control, "workspace or initial offline prompt")
        if first.get("text") == "Use Offline Storage":
            tap(first)
        wait_for(lambda root: find_text(root, "Send"), "request editor")
        print("Workspace loaded; sending local request", flush=True)
        root = hierarchy()
        edits = [node for node in root.iter("node") if node.get("class") == "android.widget.EditText"]
        if len(edits) < 2:
            raise RuntimeError("Request URL input was not found")
        url = f"http://10.0.2.2:{server.server_port}/echo"
        for _ in range(3):
            if len(edits) < 2:
                raise RuntimeError("Request editor disappeared while entering the URL")
            tap(edits[1])
            time.sleep(2)  # Wait for the IME and WebView to finish changing focus.
            adb("shell", "input", "keycombination", "KEYCODE_CTRL_LEFT", "KEYCODE_A")
            adb("shell", "input", "keyevent", "KEYCODE_DEL")
            time.sleep(0.5)
            # Individual events avoid dropping characters while React updates the editor.
            for char in url:
                adb("shell", "input", "text", char)
                time.sleep(0.2)
            # Back exits the app if the emulator has no software keyboard open.
            if "mInputShown=true" in adb("shell", "dumpsys", "input_method"):
                adb("shell", "input", "keyevent", "KEYCODE_BACK")
            root = hierarchy()
            edits = [node for node in root.iter("node") if node.get("class") == "android.widget.EditText"]
            if len(edits) >= 2 and edits[1].get("text", "").lower() == url:
                break
        else:
            raise RuntimeError("Request URL was not entered correctly")
        send = find_text(root, "Send")
        if send is None:
            raise RuntimeError("Send button was not found")
        tap(send)
        wait_for(lambda tree: next((n for n in tree.iter("node") if MARKER in n.get("text", "")), None), "fixture response")
        print("HTTP response rendered; checking draft after process restart", flush=True)
        time.sleep(2)
        adb("shell", "am", "force-stop", PACKAGE)
        adb("shell", "am", "start", "-n", PACKAGE + "/.MainActivity")
        wait_for(
            lambda tree: next((n for n in tree.iter("node") if n.get("class") == "android.widget.EditText" and n.get("text", "").lower() == url), None),
            "persisted request URL after restart",
        )
        print("Android smoke test passed: startup, HTTP request, and draft persistence")
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == "__main__":
    main()
