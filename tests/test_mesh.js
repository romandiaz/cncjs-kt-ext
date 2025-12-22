
const Mesh = require('./mesh');

// Helper to check approximate equality
function assertApprox(actual, expected, msg) {
    if (Math.abs(actual - expected) > 0.001) {
        console.error(`FAIL: ${msg} -> Expected ${expected}, got ${actual}`);
    } else {
        console.log(`PASS: ${msg} -> ${actual}`);
    }
}

// 1. Basic 2x2 Grid
// P00 (0,0,0)  P10 (10,0,0)
// P01 (0,10,10) P11 (10,10,10)
// This is a plane sloping up in Y. Z = Y.
console.log("--- TEST 1: Basic 2x2 Slope ---");
const points1 = [
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 0, y: 10, z: 10 },
    { x: 10, y: 10, z: 10 }
];
const mesh1 = new Mesh(points1);
assertApprox(mesh1.interpolateZ(5, 5), 5.0, "Center point (5,5) should be 5.0");
assertApprox(mesh1.interpolateZ(0, 5), 5.0, "Left edge (0,5) should be 5.0");
assertApprox(mesh1.interpolateZ(2, 2), 2.0, "Point (2,2) should be 2.0");

// 2. Zigzag input handling
// Should sort correctly into rows
console.log("\n--- TEST 2: Zigzag Input ---");
const points2 = [
    { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 },     // Row 0
    { x: 10, y: 10, z: 10 }, { x: 0, y: 10, z: 10 }  // Row 1 (Reverse order)
];
const mesh2 = new Mesh(points2);
assertApprox(mesh2.interpolateZ(5, 5), 5.0, "Center point (5,5) with zigzag input");

// 3. 3x3 Grid with Peak
// 10 10 10
// 10 20 10
// 10 10 10
console.log("\n--- TEST 3: 3x3 Peak ---");
const points3 = [];
for (let y = 0; y <= 20; y += 10) {
    for (let x = 0; x <= 20; x += 10) {
        let z = 10;
        if (x === 10 && y === 10) z = 20; // Peak
        points3.push({ x, y, z });
    }
}
const mesh3 = new Mesh(points3);
assertApprox(mesh3.interpolateZ(10, 10), 20.0, "Peak center");
assertApprox(mesh3.interpolateZ(5, 10), 15.0, "Slope to peak (5,10)");
assertApprox(mesh3.interpolateZ(15, 15), 15.0, "Slope corner (15,15)"); // (10+10+10+20)/4 ?
// Q11(10,10,20), Q21(20,10,10), Q12(10,20,10), Q22(20,20,10)
// At (15,15), u=0.5, v=0.5
// b = 0.5*20 + 0.5*10 = 15
// t = 0.5*10 + 0.5*10 = 10
// final = 0.5*15 + 0.5*10 = 12.5?
// Wait. 
// Cell is (10,10) to (20,20).
// Corners: (10,10,20), (20,10,10), (10,20,10), (20,20,10)
// Bottom edge lerp (y=10): x=15 -> (20+10)/2 = 15
// Top edge lerp (y=20): x=15 -> (10+10)/2 = 10
// Mid lerp (y=15): (15+10)/2 = 12.5.
assertApprox(mesh3.interpolateZ(15, 15), 12.5, "Slope corner calculation");

// 4. Out of bounds (Clamping)
console.log("\n--- TEST 4: Clamping ---");
assertApprox(mesh3.interpolateZ(-5, 0), 10.0, "Negative X clamp");
assertApprox(mesh3.interpolateZ(0, 30), 10.0, "Positive Y clamp");

console.log("\n--- Tests Complete ---");
