"""Make a fake (untrained) SkyNetLite checkpoint for testing the browser export.

    python3 make_test_model.py [--out /tmp/skynet_test.pt]

The weights are random, so its answers mean nothing; it only exists so test_parity.mjs can check that
the JavaScript maths gives the same numbers as PyTorch. To make that check meaningful, every BatchNorm
gets non-trivial values (running mean / variance / gamma / beta far from the 0 / 1 defaults); if the
JS folded BN wrongly, the logits would come out different.
"""
import argparse
import sys
from pathlib import Path

import torch
import torch.nn as nn

sys.path.insert(0, str(Path(__file__).resolve().parent))
from model import SkyNetLite  # noqa: E402

SEED = 1234


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/tmp/skynet_test.pt")
    a = ap.parse_args()
    torch.manual_seed(SEED)
    model = SkyNetLite()

    # 1. Let BN measure real activation statistics on a few random batches, so activations stay a sensible
    #    size through all 7 layers (otherwise the logits could shrink to ~0 and the test would prove little).
    for m in model.modules():
        if isinstance(m, nn.BatchNorm2d):
            m.momentum = None  # plain average over the batches
    model.train()
    with torch.no_grad():
        for _ in range(4):
            model(torch.randn(16, 3, 64, 64))

    # 2. Then scramble every BN so none of its four numbers is at a default value.
    with torch.no_grad():
        for m in model.modules():
            if isinstance(m, nn.BatchNorm2d):
                n = m.num_features
                m.running_mean += torch.randn(n) * 0.2 * m.running_var.sqrt()
                m.running_var *= torch.empty(n).uniform_(0.5, 2.0)
                m.weight.copy_(torch.empty(n).uniform_(0.5, 1.5))
                m.bias.copy_(torch.empty(n).uniform_(-0.3, 0.3))
        model.fc.weight.mul_(4.0)  # bigger logits, so a 1e-3 tolerance is a real test
        model.fc.bias.uniform_(-0.5, 0.5)
    model.eval()

    torch.save({"model": model.state_dict(), "note": "random test model, not trained"}, a.out)
    with torch.no_grad():
        print(f"wrote {a.out}; sample logits {model(torch.randn(2, 3, 64, 64)).numpy().round(3).tolist()}")


if __name__ == "__main__":
    main()
