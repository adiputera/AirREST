#!/usr/bin/env python3
"""Check native ELF and APK alignment for Android's 16 KiB page size."""

import argparse
import pathlib
import subprocess
import tempfile
import zipfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("apk", type=pathlib.Path)
    parser.add_argument("--readelf", required=True)
    parser.add_argument("--zipalign", required=True)
    args = parser.parse_args()

    subprocess.run([args.zipalign, "-c", "-P", "16", "4", str(args.apk)], check=True)
    with zipfile.ZipFile(args.apk) as apk, tempfile.TemporaryDirectory() as directory:
        libraries = [name for name in apk.namelist() if name.startswith("lib/") and name.endswith(".so")]
        if not libraries:
            raise SystemExit("APK contains no native libraries")
        for index, name in enumerate(libraries):
            library = pathlib.Path(directory) / f"{index}.so"
            library.write_bytes(apk.read(name))
            output = subprocess.check_output([args.readelf, "-lW", str(library)], text=True)
            segments = [line.split() for line in output.splitlines() if line.strip().startswith("LOAD ")]
            if not segments or any(int(segment[-1], 0) < 16384 for segment in segments):
                raise SystemExit(f"Native library is not 16 KiB aligned: {name}")
            print(f"16 KiB ELF alignment OK: {name}")
    print("APK zip alignment OK")


if __name__ == "__main__":
    main()
