
G21
G90
G0 Z5
G0 X0 Y0
G1 X10 Y0 ; Move 1
G1 X10 Y0 F500 ; Zero move, only F change
G1 X10 Y0 ; Zero move, duplicate
G2 X20 Y0 I5 J0 ; Arc
G1 X30 Y0
