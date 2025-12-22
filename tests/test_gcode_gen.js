const fs = require('fs');
const Autolevel = require('../src/extension/autolevel');

// Mock Socket
const mockSocket = {
    on: () => { },
    emit: () => { }
};

// Mock Options
const options = {
    port: '/dev/ttyMock',
    outDir: '.'
};

// Instantiate Autolevel
const al = new Autolevel(mockSocket, options);

// Mock sckw (SocketWrap)
al.sckw = {
    sendGcode: (msg) => console.log('MockSend:', msg),
    loadGcode: (name, gcode) => {
        console.log('--- GENERATED GCODE START ---');
        // console.log(gcode);
        console.log('--- GENERATED GCODE END ---');
        console.log('Total Lines:', gcode.split('\n').length);
        fs.writeFileSync('output_test.gcode', gcode);
    }
};

// Load G-code
try {
    const gcode = fs.readFileSync('supports.gcode', 'utf8');
    al.gcode = gcode;
    al.gcodeFileName = 'supports.gcode';

    // Valid 3 points to allow it to run
    al.probedPoints = [
        { x: 0, y: 0, z: 0 },
        { x: 100, y: 0, z: 0 },
        { x: 0, y: 100, z: 0 }
    ];

    // Run
    console.log('Starting applyCompensation...');
    al.applyCompensation(); // This triggers the logic
    console.log('Finished.');

} catch (err) {
    console.error('Error:', err);
}
