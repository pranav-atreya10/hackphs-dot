"""SkyNetLite: a small CNN that labels a 64x64 crop as bird, drone or other.

Layout (every conv is 3x3, padding 1, followed by BatchNorm and ReLU):
  stem   3 ->  32, stride 2   64x64 -> 32x32
  c2    32 ->  32             then 2x2 max pool -> 16x16
  c3    32 ->  64
  c4    64 ->  64             then 2x2 max pool -> 8x8
  c5    64 -> 128
  c6   128 -> 128             then 2x2 max pool -> 4x4
  c7   128 -> 160             then global average pool -> 160 numbers
  fc   160 ->   3             (bird, drone, other)
About 472K parameters. Input is RGB scaled to 0..1, then normalised with MEAN / STD below.
"""
import torch
import torch.nn as nn

MEAN = [0.5, 0.5, 0.5]
STD = [0.25, 0.25, 0.25]
LAYERS = [  # (name, in, out, stride, pool_after)
    ("stem", 3, 32, 2, False),
    ("c2", 32, 32, 1, True),
    ("c3", 32, 64, 1, False),
    ("c4", 64, 64, 1, True),
    ("c5", 64, 128, 1, False),
    ("c6", 128, 128, 1, True),
    ("c7", 128, 160, 1, False),
]


class SkyNetLite(nn.Module):
    def __init__(self, n_classes=3):
        super().__init__()
        blocks = []
        for name, cin, cout, stride, pool in LAYERS:
            blocks += [nn.Conv2d(cin, cout, 3, stride, 1, bias=False), nn.BatchNorm2d(cout), nn.ReLU(inplace=True)]
            if pool:
                blocks.append(nn.MaxPool2d(2))
        self.features = nn.Sequential(*blocks)
        self.dropout = nn.Dropout(0.2)
        self.fc = nn.Linear(LAYERS[-1][2], n_classes)

    def forward(self, x):
        x = self.features(x).mean(dim=(2, 3))
        return self.fc(self.dropout(x))


def count_params(model):
    return sum(p.numel() for p in model.parameters())


if __name__ == "__main__":
    m = SkyNetLite()
    print(f"{count_params(m):,} parameters")
    print(m(torch.zeros(2, 3, 64, 64)).shape)
