# Vote of 5 consecutive crops per track vs 1 crop

| Test set | Birds: 1 frame | Birds: vote of N | Drones: 1 frame | Drones: vote of N | False alarms: 1 frame | False alarms: vote of N |
|---|---|---|---|---|---|---|
| svanstrom (real size) | 95.3% (91-99) | 97.4% (95-99) | 90.8% (84-97) | 91.9% (84-98) | 7.6% (4-12) | 2.2% (0-4) |
| svanstrom YouTube planes/helicopters | n/a | n/a | n/a | n/a | 29.3% (24-34) | 13.8% (10-18) |
| svanstrom shrunk 7 px | 71.8% (60-84) | 69.7% (54-87) | 78.6% (69-88) | 80.6% (71-90) | 11.4% (6-16) | 3.6% (1-6) |
| svanstrom shrunk 10 px | 89.8% (83-96) | 92.1% (84-99) | 81.8% (73-91) | 82.3% (72-92) | 11.7% (6-18) | 5.3% (2-9) |
| svanstrom shrunk 13 px | 92.0% (87-96) | 94.7% (89-100) | 83.9% (75-92) | 87.1% (77-96) | 11.3% (6-17) | 5.0% (1-9) |
| FBD-SV (never-seen source) | 72.8% (70-76) | 86.4% (82-90) | n/a | n/a | 15.8% (14-17) | 1.9% (1-3) |
