"""Synthetic fixture evaluation (mirrors the real argparse contract; exit 0/1)."""
import argparse
import os
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--agent_workspace", required=False)
    parser.add_argument("--groundtruth_workspace", required=False)
    parser.add_argument("--launch_time", required=False)
    parser.add_argument("--res_log_file", required=False)
    args = parser.parse_args()
    ok = bool(args.agent_workspace) and os.path.isdir(args.agent_workspace)
    print("[PASS]" if ok else "[FAIL]")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
