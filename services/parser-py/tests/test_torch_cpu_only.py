"""
torch must be the CPU build.

torch and torchvision arrive transitively through
unstructured[local-inference] → unstructured-inference → layoutparser, and
upstream pins neither. PyPI serves the CUDA build, so an unpinned resolve drags
in the whole nvidia-*/triton stack — several GB of GPU libraries that nothing in
this service can use.

On 2026-09-02 torch 2.14.0 moved that stack to CUDA 13 and pushed the install
past the GitHub runner's disk. CI failed with
"OSError: [Errno 28] No space left on device" during dependency installation, on
a documentation-only PR, having been green the previous day on an identical
tree. requirements.txt now pins the +cpu wheels from the PyTorch index.

This guard exists because the natural failure mode is terrible: the pin does not
break a test, it exhausts a disk several minutes into an unrelated job, and the
error names neither torch nor this file. Asserting the build directly turns that
into an immediate, self-explaining failure.
"""

from __future__ import annotations

import pytest

torch = pytest.importorskip("torch", reason="torch is an optional OCR-path dependency")


def test_torch_is_a_cpu_build() -> None:
    """A CUDA build here means the +cpu pin was dropped or overridden."""
    assert torch.version.cuda is None, (
        f"torch reports CUDA {torch.version.cuda}; expected the CPU build. "
        "requirements.txt pins torch==<ver>+cpu from "
        "https://download.pytorch.org/whl/cpu — something has overridden it. "
        "The CUDA wheels pull several GB of nvidia-* packages and will exhaust "
        "the CI runner's disk."
    )


def test_torch_version_carries_the_cpu_local_tag() -> None:
    """
    The +cpu local version exists only on the PyTorch index, so its presence is
    what proves the wheel came from there rather than from PyPI.
    """
    assert torch.__version__.endswith("+cpu"), (
        f"torch.__version__ is {torch.__version__!r}, which lacks the '+cpu' "
        "local version tag. Even a CUDA-less wheel from PyPI would drift back "
        "to the GPU build on the next resolve."
    )
