"""Synthetic fixture preprocess (mirrors the real argparse contract)."""
import argparse


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--agent_workspace", required=False)
    parser.add_argument("--launch_time", required=False)
    parser.parse_args()
    print("fixture preprocess: nothing to seed")


if __name__ == "__main__":
    main()
