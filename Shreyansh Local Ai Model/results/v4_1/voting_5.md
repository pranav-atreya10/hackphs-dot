# Vote of 5 consecutive crops per track vs 1 crop

| Test set | Birds: 1 frame | Birds: vote of N | Drones: 1 frame | Drones: vote of N | False alarms: 1 frame | False alarms: vote of N |
|---|---|---|---|---|---|---|
| svanstrom (real size) | 93.6% (88-98) | 96.1% (92-99) | 94.4% (90-98) | 96.0% (92-99) | 6.1% (3-9) | 1.0% (0-2) |
| svanstrom YouTube planes/helicopters | n/a | n/a | n/a | n/a | 25.7% (21-31) | 8.7% (6-12) |
| svanstrom shrunk 7 px | 69.0% (54-84) | 65.8% (49-84) | 85.9% (79-92) | 88.4% (81-95) | 9.9% (5-14) | 2.6% (1-5) |
| svanstrom shrunk 10 px | 86.5% (79-94) | 89.5% (80-98) | 90.1% (84-95) | 92.7% (86-98) | 10.7% (6-16) | 3.0% (1-5) |
| svanstrom shrunk 13 px | 90.0% (84-96) | 93.4% (85-100) | 91.7% (86-96) | 94.0% (89-98) | 10.1% (5-15) | 3.0% (1-6) |
| FBD-SV (never-seen source) | 81.5% (79-84) | 91.0% (88-94) | n/a | n/a | 15.1% (14-17) | 2.1% (1-3) |
