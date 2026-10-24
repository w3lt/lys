"""Tests of the page reader, which the image does not copy.

Run them from the repository root with Python 3.12 or later:

    python3 -m unittest discover -s sandboxes/readpage/tests -t sandboxes/readpage

The cases that read pages in Chromium need ``chromium-headless-shell`` on PATH,
as the image has it, and are skipped, each with that reason, without it.
"""
