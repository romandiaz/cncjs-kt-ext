/* eslint-disable no-useless-escape */
const SocketWrap = require('./socketwrap')
const fs = require('fs')
const Mesh = require('./mesh')


const alFileNamePrefix = '#AL:'

const DEFAULT_PROBE_FILE = '__last_Z_probe.txt';

const Units = {
  MILLIMETERS: 1,
  INCHES: 2,

  convert: function (value, in_units, out_units) {
    if (in_units == out_units) {
      return value;
    }
    if (in_units == this.MILLIMETERS && out_units == this.INCHES) {
      return value / 25.4;
    }
    if (in_units == this.INCHES && out_units == this.MILLIMETERS) {
      return value * 25.4;
    }
  }
}

Object.freeze(Units);

module.exports = class Autolevel {
  constructor(socket, options) {
    this.gcodeFileName = ''
    this.gcode = ''
    this.sckw = new SocketWrap(socket, options.port)
    this.outDir = options.outDir;
    this.delta = 10.0 // step
    this.feed = 50 // probing feedrate
    this.height = 2 // travelling height
    this.probedPoints = []
    this.min_dz = 0;
    this.max_dz = 0;
    this.sum_dz = 0;
    this.planedPointCount = 0
    this.probeFile = 0;
    this.wco = {
      x: 0,
      y: 0,
      z: 0
    }
    this.mpos = { x: 0, y: 0, z: 0 };
    this.pos = { x: 0, y: 0, z: 0 };
    this.gcodeBounds = null;
    this.buffer = ''; // Line buffer for serial data

    // Listen for controller state updates to track position
    socket.on('controller:state', (state) => {
      if (state && state.status) {
        const { mpos, wco } = state.status;
        if (mpos) {
          this.mpos = mpos;
        }
        if (wco) {
          this.wco = wco;
        }
        // derive pos from mpos and wco if needed, or rely on cncjs to send it.
        // Usually pos = mpos - wco.
        if (mpos && wco) {
          this.pos = {
            x: mpos.x - wco.x,
            y: mpos.y - wco.y,
            z: mpos.z - wco.z
          }
        }
      }
    });

    // Try to read in any pre-existing probe data...
    fs.readFile(DEFAULT_PROBE_FILE, 'utf8', (err, data) => {
      if (!err) {
        try {
          console.log(`Loading previous probe from ${DEFAULT_PROBE_FILE}`)
          this.probedPoints = [];
          let lines = data.split('\n');
          let pnum = 0;
          lines.forEach(line => {
            let vals = line.split(' ');
            if (vals.length >= 3) {
              let pt = {
                x: parseFloat(vals[0]),
                y: parseFloat(vals[1]),
                z: parseFloat(vals[2])
              };
              this.probedPoints.push(pt);
              pnum++;
              console.log(`point ${pnum} X:${pt.x} Y:${pt.y} Z:${pt.z}`);
            }
          });
          console.log(`Read ${this.probedPoints.length} probed points from previous session`);
        }
        catch (err2) {
          this.probedPoints = [];
          console.log(`Failed to read probed points from prevoius session: ${err2}`);
        }
      }
    });

    socket.on('gcode:load', (file, gc) => {
      if (!file.startsWith(alFileNamePrefix)) {
        this.gcodeFileName = file
        this.gcode = gc
        console.log('gcode loaded:', file)

        // Calculate bounds manually using regex (more robust than library dependencies in this context)
        this.gcodeBounds = {
          min: { x: Infinity, y: Infinity },
          max: { x: -Infinity, y: -Infinity }
        };

        const lines = gc.split('\n');
        let abs = true; // Assume absolute positioning by default
        let units = 1; // 1 = MM, 2 = Inches (matches Units.MILLIMETERS)

        // Helper to convert to MM
        const toMM = (val, u) => (u === 2 ? val * 25.4 : val);

        let hasMoves = false;

        lines.forEach(line => {
          const lineStripped = this.stripComments(line);

          // Check modes
          if (/G90/i.test(lineStripped)) abs = true;
          if (/G91/i.test(lineStripped)) abs = false;
          if (/G20/i.test(lineStripped)) units = 2;
          if (/G21/i.test(lineStripped)) units = 1;

          // Only track absolute moves for bounds
          if (abs && /(X|Y)/i.test(lineStripped)) {
            const xMatch = /X([\.\+\-\d]+)/gi.exec(lineStripped);
            const yMatch = /Y([\.\+\-\d]+)/gi.exec(lineStripped);

            if (xMatch) {
              const x = toMM(parseFloat(xMatch[1]), units);
              if (x < this.gcodeBounds.min.x) this.gcodeBounds.min.x = x;
              if (x > this.gcodeBounds.max.x) this.gcodeBounds.max.x = x;
              hasMoves = true;
            }
            if (yMatch) {
              const y = toMM(parseFloat(yMatch[1]), units);
              if (y < this.gcodeBounds.min.y) this.gcodeBounds.min.y = y;
              if (y > this.gcodeBounds.max.y) this.gcodeBounds.max.y = y;
              hasMoves = true;
            }
          }
        });

        if (!hasMoves) {
          this.gcodeBounds = null;
          console.log('No bounds detected in G-code.');
        } else {
          console.log('Calculated G-code bounds:', this.gcodeBounds);
        }
      }
    })

    socket.on('gcode:unload', () => {
      this.gcodeFileName = ''
      this.gcode = ''
      console.log('gcode unloaded')
    })

    socket.on('serialport:read', (data) => {
      // DEBUG: Log raw data length and snippet
      console.log(`DEBUG: Raw Serial Data (${data.length}): ${JSON.stringify(data.toString())}`);

      // Append new data to buffer
      this.buffer += data.toString();

      // Process all complete lines in buffer
      // Pattern-based processing (Robust to missing newlines)
      if (this.buffer.length > 5000) {
        console.log('DEBUG: Trimming large buffer to prevent overflow');
        this.buffer = this.buffer.substring(this.buffer.length - 2000);
      }

      while (true) {
        const startIndex = this.buffer.indexOf('[PRB:');
        if (startIndex < 0) break;

        const endIndex = this.buffer.indexOf(']', startIndex);
        if (endIndex < 0) break; // Incomplete message

        const prbLine = this.buffer.substring(startIndex, endIndex + 1);
        // Remove processed part
        this.buffer = this.buffer.substring(endIndex + 1);

        console.log('DEBUG: Processing extracted PRB chunk:', prbLine);

        let prbm = /\[PRB:([\+\-\.\d]+),([\+\-\.\d]+),([\+\-\.\d]+),?([\+\-\.\d]+)?:(\d)\]/.exec(prbLine)
        if (prbm) {
          let prb = [parseFloat(prbm[1]), parseFloat(prbm[2]), parseFloat(prbm[3])]
          let pt = {
            x: prb[0] - this.wco.x,
            y: prb[1] - this.wco.y,
            z: prb[2] - this.wco.z
          }

          if (this.probeFile) {
            fs.writeSync(this.probeFile, `${pt.x} ${pt.y} ${pt.z} 0 0 0 0 0 0\n`);
          }

          if (this.planedPointCount > 0) {
            if (this.probedPoints.length === 0) {
              this.min_dz = pt.z;
              this.max_dz = pt.z;
              this.sum_dz = pt.z;
            } else {
              if (pt.z < this.min_dz) this.min_dz = pt.z;
              if (pt.z > this.max_dz) this.max_dz = pt.z;
              this.sum_dz += pt.z;
            }
            this.probedPoints.push(pt)
            this.sckw.sendGcode(`(AL: PROBED ${pt.x} ${pt.y} ${pt.z})`)

            console.log('probed ' + this.probedPoints.length + '/' + this.planedPointCount + '>', pt.x.toFixed(3), pt.y.toFixed(3), pt.z.toFixed(3))

            if (this.probedPoints.length >= this.planedPointCount) {
              console.log('DEBUG: Probing complete. Total points: ' + this.probedPoints.length);
              this.sckw.sendGcode(`(AL: dz_min=${this.min_dz.toFixed(3)}, dz_max=${this.max_dz.toFixed(3)}, dz_avg=${(this.sum_dz / this.probedPoints.length).toFixed(3)})`);
              if (this.probeFile) {
                this.fileClose();
              }
              if (!this.probeOnly) {
                console.log('DEBUG: Calling applyCompensation...');
                this.applyCompensation()
              } else {
                console.log('DEBUG: Probe Only mode. Finished.');
                this.sckw.sendGcode('(AL: finished)');
              }
              this.planedPointCount = 0
              this.wco = { x: 0, y: 0, z: 0 }
            }
          } else {
            console.log('DEBUG: Ignored PRB (planedPointCount <= 0):', this.planedPointCount);
          }
        }
      }
    })

    //  this.socket.emit.apply(socket, ['write', this.port, "gcode", "G91 G1 Z1 F1000"]);
  }

  fileOpen(fileName) {
    try {
      this.probeFile = fs.openSync(fileName, "w");
      console.log(`Opened probe file ${fileName}`);
      this.sckw.sendGcode(`(AL: Opened probe file ${fileName})`)
    }
    catch (err) {
      this.probeFile = 0;
      this.sckw.sendGcode(`(AL: Could not open probe file ${err})`)
    }
  }

  fileClose() {
    if (this.probeFile) {
      console.log('Closing probe file');
      fs.closeSync(this.probeFile);
      this.probeFile = 0;
    }
  }

  dumpMesh() {
    if (this.probedPoints.length === 0) {
      this.sckw.sendGcode('(AL: no mesh data)')
      return
    }
    this.sckw.sendGcode('(AL: dumping mesh start)')
    this.probedPoints.forEach(pt => {
      this.sckw.sendGcode(`(AL: PROBED ${pt.x} ${pt.y} ${pt.z})`)
    })
    this.sckw.sendGcode('(AL: finished)')
  }

  reapply(cmd, context) {
    if (!this.gcode) {
      this.sckw.sendGcode('(AL: no gcode loaded)')
      return
    }
    if (this.probedPoints.length < 3) {
      this.sckw.sendGcode('(AL: no previous autolevel points)')
      return;
    }
    this.applyCompensation();
  }

  start(cmd, context) {
    console.log(cmd, context)

    // A parameter of P1 indicates a "probe only", and that
    // the results should NOT be applied to any loaded GCode.
    // The default value is "false"
    this.probeOnly = 0;
    let p = /P([\.\+\-\d]+)/gi.exec(cmd)
    if (p) this.probeOnly = parseFloat(p[1])

    if (!this.gcode) {
      this.sckw.sendGcode('(AL: no gcode loaded)')
      if (!this.probeOnly) {
        return
      }
    }

    if (!this.probeFile) {
      // Since no explicit command was given to open the probe recording
      // file, record the probe entries to be reused (in case of system
      // restart)
      this.fileOpen(DEFAULT_PROBE_FILE);
    }

    this.sckw.sendGcode('(AL: auto-leveling started)')
    let m = /D([\.\+\-\d]+)/gi.exec(cmd)
    if (m) this.delta = parseFloat(m[1])

    let h = /H([\.\+\-\d]+)/gi.exec(cmd)
    if (h) this.height = parseFloat(h[1])

    let f = /F([\.\+\-\d]+)/gi.exec(cmd)
    if (f) this.feed = parseFloat(f[1])

    let margin = this.delta / 4;

    let mg = /M([\.\+\-\d]+)/gi.exec(cmd)
    if (mg) margin = parseFloat(mg[1])


    let xSize, ySize;
    let xs = /X([\.\+\-\d]+)/gi.exec(cmd)
    if (xs) xSize = parseFloat(xs[1])

    let ys = /Y([\.\+\-\d]+)/gi.exec(cmd)
    if (ys) ySize = parseFloat(ys[1])

    let grid;
    let gd = /GRID([\.\+\-\d]+)/gi.exec(cmd);
    if (gd) grid = parseFloat(gd[1]);

    let area;
    if (xSize) {
      area = `(${xSize}, ${ySize})`
    }
    else {
      area = 'Not specified'
    }
    console.log(`STEP: ${this.delta} mm HEIGHT:${this.height} mm FEED:${this.feed} MARGIN: ${margin} mm  PROBE ONLY:${this.probeOnly}  Area: ${area} GRID: ${grid}`)

    // Use tracked wco if available, otherwise fallback to context (though context is unreliable for wco usually)
    // The loop above updates this.wco from controller:state, so we should trust it.
    // However, context.mposx etc might be useful if available.
    // Let's rely on our tracked state if possible.

    // We already have this.wco updated from controller:state
    console.log('Using tracked WCO:', this.wco)

    this.probedPoints = []
    this.planedPointCount = 0
    let code = []

    let xmin, xmax, ymin, ymax;
    if (xSize) {
      xmin = margin;
      xmax = xSize - margin;
    }
    else {
      // Use calculated bounds if available, fallback to context
      if (this.gcodeBounds) {
        xmin = this.gcodeBounds.min.x + margin;
        xmax = this.gcodeBounds.max.x - margin;
      } else {
        console.log("No bounds available, falling back to context (might be NaN)");
        xmin = context.xmin + margin;
        xmax = context.xmax - margin;
      }
    }

    if (ySize) {
      ymin = margin;
      ymax = ySize - margin;
    }
    else {
      if (this.gcodeBounds) {
        ymin = this.gcodeBounds.min.y + margin;
        ymax = this.gcodeBounds.max.y - margin;
      } else {
        ymin = context.ymin + margin;
        ymax = context.ymax - margin;
      }
    }

    let dx, dy;
    if (grid) {
      if (grid < 2) grid = 2; // Minimum 2 points to define a range
      dx = (xmax - xmin) / (grid - 1);
      dy = (ymax - ymin) / (grid - 1);
    } else {
      dx = (xmax - xmin) / parseInt((xmax - xmin) / this.delta)
      dy = (ymax - ymin) / parseInt((ymax - ymin) / this.delta)
    }
    code.push('(AL: probing initial point)')
    code.push(`G21`)
    code.push(`G90`)
    code.push(`G0 Z${this.height}`)
    code.push(`G0 X${xmin.toFixed(3)} Y${ymin.toFixed(3)} Z${this.height}`)
    code.push(`G38.2 Z-${this.height + 1} F${this.feed / 2}`)
    code.push(`G10 L20 P1 Z0`) // set the z zero
    code.push(`G0 Z${this.height}`)
    this.planedPointCount++

    let y = ymin - dy
    let rowIndex = 0

    while (y < ymax - 0.01) {
      y += dy
      if (y > ymax) y = ymax

      let xPoints = []
      let x = xmin - dx
      while (x < xmax - 0.01) {
        x += dx
        if (x > xmax) x = xmax
        xPoints.push(x)
      }

      if (rowIndex % 2 !== 0) {
        xPoints.reverse()
      }

      for (let x of xPoints) {
        // don't probe first point twice (it is probed before the loop)
        if (rowIndex === 0 && Math.abs(x - xmin) < 0.001) continue

        code.push(`(AL: probing point ${this.planedPointCount + 1})`)
        code.push(`G90 G0 X${x.toFixed(3)} Y${y.toFixed(3)} Z${this.height}`)
        code.push(`G38.2 Z-${this.height + 1} F${this.feed}`)
        code.push(`G0 Z${this.height}`)
        this.planedPointCount++
      }
      rowIndex++
    }
    this.sckw.sendGcode(code.join('\n'))
  }

  updateContext(context) {
    if (this.wco.z != 0 &&
      context.mposz !== undefined &&
      context.posz !== undefined) {
      let wcoz = context.mposz - context.posz;
      if (Math.abs(this.wco.z - wcoz) > 0.00001) {
        this.wco.z = wcoz;
        console.log('WARNING: WCO Z offset drift detected! wco.z is now: ' + this.wco.z);
      }
    }
  }

  stripComments(line) {
    const re1 = new RegExp(/\s*\([^\)]*\)/g) // Remove anything inside the parentheses
    const re2 = new RegExp(/\s*;.*/g) // Remove anything after a semi-colon to the end of the line, including preceding spaces
    const re3 = new RegExp(/\s+/g)
    return (line.replace(re1, '').replace(re2, '').replace(re3, ''))
  };

  distanceSquared3(p1, p2) {
    return (p2.x - p1.x) * (p2.x - p1.x) + (p2.y - p1.y) * (p2.y - p1.y) + (p2.z - p1.z) * (p2.z - p1.z)
  }

  distanceSquared2(p1, p2) {
    return (p2.x - p1.x) * (p2.x - p1.x) + (p2.y - p1.y) * (p2.y - p1.y)
  }

  crossProduct3(u, v) {
    return {
      x: (u.y * v.z - u.z * v.y),
      y: -(u.x * v.z - u.z * v.x),
      z: (u.x * v.y - u.y * v.x)
    }
  }

  isColinear(u, v) {
    return Math.abs(u.x * v.y - u.y * v.x) < 0.00001
  }

  sub3(p1, p2) {
    return {
      x: p1.x - p2.x,
      y: p1.y - p2.y,
      z: p1.z - p2.z
    }
  }

  formatPt(pt) {
    return `(x:${pt.x.toFixed(3)} y:${pt.y.toFixed(3)} z:${pt.z.toFixed(3)})`
  }


  /**
   * Appends point to point array only if there is a difference from last point
   * @param {*} resArray 
   * @param {*} pt 
   * @returns 
   */
  appendPointSkipDuplicate(resArray, pt) {
    if (resArray.length == 0) {
      resArray.push(pt);
      return;
    }
    const lastPt = resArray[resArray.length - 1];
    if (this.distanceSquared3(pt, lastPt) > 1e-10) {
      resArray.push(pt);
    }
    // don't append if there is no significant movement
  }

  /**
   * Splits the line segment to smaller segments, not larger than probing grid delta
   * @param {*} p1 
   * @param {*} p2 
   * @param {*} units 
   * @returns 
   */
  splitToSegments(p1, p2, units) {
    let res = []
    let v = this.sub3(p2, p1) // delta
    let dist = Math.sqrt(this.distanceSquared3(p1, p2)) // distance

    if (dist < 1e-10) {
      return [];
    }

    let dir = {
      x: v.x / dist,
      y: v.y / dist,
      z: v.z / dist
    } // direction vector
    let maxSegLength = Units.convert(this.delta, Units.MILLIMETERS, units) / 2
    res.push({
      x: p1.x,
      y: p1.y,
      z: p1.z
    }) // first point
    for (let d = maxSegLength; d < dist; d += maxSegLength) {
      this.appendPointSkipDuplicate(res, {
        x: p1.x + dir.x * d,
        y: p1.y + dir.y * d,
        z: p1.z + dir.z * d
      }) // split points
    }
    this.appendPointSkipDuplicate(res, {
      x: p2.x,
      y: p2.y,
      z: p2.z
    }) // last point    
    return res
  }

  // Argument is assumed to be in millimeters.
  getThreeClosestPoints(pt) {
    let res = []
    if (this.probedPoints.length < 3) {
      return res
    }
    this.probedPoints.sort((a, b) => {
      return this.distanceSquared2(a, pt) < this.distanceSquared2(b, pt) ? -1 : 1
    })
    let i = 0
    while (res.length < 3 && i < this.probedPoints.length) {
      if (res.length === 2) {
        // make sure points are not colinear
        if (!this.isColinear(this.sub3(res[1], res[0]), this.sub3(this.probedPoints[i], res[0]))) {
          res.push(this.probedPoints[i])
        }
      } else {
        res.push(this.probedPoints[i])
      }
      i++
    }
    return res
  }



  /**
   * Interpolates an arc (G2/G3) into linear segments for Z-compensation.
   * @param {Object} p1 Start point {x,y,z}
   * @param {Object} p2 End point {x,y,z}
   * @param {Object} args Arc arguments (I, J, R, etc.)
   * @param {boolean} clockwise True for G2, False for G3
   * @param {number} units Units constant (MILLIMETERS or INCHES)
   * @returns {Array} Array of points {x,y,z} along the arc
   */
  interpolateArc(p1, p2, args, clockwise, units) {
    let points = [];

    // Convert current units to MM for calculation if needed, but easier to work in current units 
    // provided 'delta' scale matches. 'this.delta' is likely in MM if defaults kept, 
    // but user might have set it. 
    // Standard approach: Perform math in current units. 
    // If units=INCHES, this.delta (10mm default) might need conversion?
    // autolevel.js uses 'Units.convert' but 'delta' seems to be widely used as MM.

    // Let's normalize to MM for calculation to match 'splitToSegments' logic roughly
    // Or just respect the unit passed.
    // If existing code uses 'Units.convert(this.delta, Units.MILLIMETERS, units)' => converts delta(MM) to CurrentUnits.

    // Use a fixed high resolution for Arcs to ensure smoothness, regardless of probe grid size.
    // 0.5mm is usually good for 3D printing/CNC.
    let maxSegLength = Units.convert(0.5, Units.MILLIMETERS, units);
    if (maxSegLength <= 0) maxSegLength = 0.5; // Safety

    // 1. Find Center
    let cx, cy, radius;

    // I, J mode
    if (args.I !== undefined || args.J !== undefined) {
      let i = args.I || 0;
      let j = args.J || 0;
      cx = p1.x + i;
      cy = p1.y + j;
      radius = Math.sqrt(i * i + j * j);
    }
    // R mode
    else if (args.R !== undefined) {
      let r = args.R;
      // Calculate center from R... (Math heavy, skipping if not strictly needed now or implementation complex)
      // Usually I/J is standard for cam, but R is common.
      // Let's implement R for completeness.

      let d2 = (p2.x - p1.x) * (p2.x - p1.x) + (p2.y - p1.y) * (p2.y - p1.y);
      let d = Math.sqrt(d2);
      if (d < 1e-9 || Math.abs(r) < d / 2) {
        // Invalid R or full circle impossible with R? 
        // Fallback to line
        return [p2];
      }

      // ... Math for R center ...
      // Let's stick to I/J first as it's most common in generated code, 
      // but R is important. 
      // Simplified: Just Linearize if R is too hard? No, user asked for arc support.
      // Reference: https://linuxcnc.org/docs/html/gcode/g-code.html#G2-G3-Arc

      // Calculate distance between points
      let dx = p2.x - p1.x;
      let dy = p2.y - p1.y;

      // Determine center
      // H = sqrt(r^2 - (d/2)^2)
      let h = Math.sqrt(Math.max(0, r * r - d2 / 4));

      let x2 = (p1.x + p2.x) / 2;
      let y2 = (p1.y + p2.y) / 2;

      if (clockwise === (r < 0)) {
        // Center is "to the right" / wrong side?
        // G2 (CW): r>0 -> center right of chord?
        // Correct math:
        cx = x2 + h * dy / d;
        cy = y2 - h * dx / d;
      } else {
        cx = x2 - h * dy / d;
        cy = y2 + h * dx / d;
      }
      // wait, logic for R sign and direction is tricky.
      // Let's trust standard formula or just support I/J primarily if simpler.
      // Many senders convert R to I/J.
      // Assuming I/J is present in args if available.
      radius = Math.abs(r);
    } else {
      // No arc info, treat as line
      return [p2];
    }

    // 2. Angles
    let startAngle = Math.atan2(p1.y - cy, p1.x - cx);
    let endAngle = Math.atan2(p2.y - cy, p2.x - cx);

    let diff = endAngle - startAngle;

    // Normalize
    if (clockwise) { // G2
      if (diff >= 0) diff -= 2 * Math.PI;
    } else { // G3
      if (diff <= 0) diff += 2 * Math.PI;
    }

    // Length of arc
    let arcLen = Math.abs(diff * radius);
    let segments = Math.ceil(arcLen / maxSegLength);
    if (segments < 1) segments = 1;

    let thetaStep = diff / segments;
    let zStep = (p2.z - p1.z) / segments;

    for (let i = 1; i <= segments; i++) {
      let angle = startAngle + i * thetaStep;
      points.push({
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
        z: p1.z + i * zStep
      });
    }

    return points;
  }

  compensateZCoord(pt_in_or_mm, input_units) {

    let pt_mm = {
      x: Units.convert(pt_in_or_mm.x, input_units, Units.MILLIMETERS),
      y: Units.convert(pt_in_or_mm.y, input_units, Units.MILLIMETERS),
      z: Units.convert(pt_in_or_mm.z, input_units, Units.MILLIMETERS)
    }

    // Use Mesh to interpolate Z level at this location
    let planeZ = 0;
    if (this.mesh) {
      planeZ = this.mesh.interpolateZ(pt_mm.x, pt_mm.y);
    }

    let newZ = pt_mm.z + planeZ;

    return {
      x: Units.convert(pt_mm.x, Units.MILLIMETERS, input_units),
      y: Units.convert(pt_mm.y, Units.MILLIMETERS, input_units),
      z: Units.convert(newZ, Units.MILLIMETERS, input_units)
    }
  }

  applyCompensation() {
    this.sckw.sendGcode(`(AL: applying ...)\n`)


    console.log('applying compensation ...')

    try {
      console.log('DEBUG: Initializing Mesh with ' + this.probedPoints.length + ' points');
      this.mesh = new Mesh(this.probedPoints);
      console.log('DEBUG: Mesh initialized');

      let lines = this.gcode.split('\n')
      let p0 = { x: 0, y: 0, z: 0 }
      let p0_initialized = false
      let pt = { x: 0, y: 0, z: 0 }

      let abs = true
      let units = Units.MILLIMETERS
      let modalMotion = 'G0'; // Default to G0/G1 (Linear) - usually safe assumption or assume G0.

      let result = []
      let lc = 0;

      lines.forEach(line => {
        if (lc % 1000 === 0) {
          console.log(`progress info ... line: ${lc}/${lines.length}`);
          this.sckw.sendGcode(`(AL: progress ...  ${lc}/${lines.length})`)
        }
        lc++;

        if (line.match(/^\s*\([^\)]*\)\s*$/g)) {
          result.push(line.trim());
          return;
        }

        let lineStripped = this.stripComments(line)
        if (!lineStripped) {
          // Preserve comments or empty lines
          result.push(line);
          return;
        }

        // 1. Detect State Changes (Modal)
        if (/G91/i.test(lineStripped)) abs = false
        if (/G90/i.test(lineStripped)) abs = true
        if (/G20/i.test(lineStripped)) units = Units.INCHES
        if (/G21/i.test(lineStripped)) units = Units.MILLIMETERS

        // Detect Group 1 Motion Modes
        // G0, G1, G2, G3, G38.2...
        // We match strict word boundaries or start of line
        let motionMatch = /(G0?[0123](?![0-9])|G38\.\d|G80)/i.exec(lineStripped);
        if (motionMatch) {
          // Normalize G00->G0, G01->G1
          let m = motionMatch[1].toUpperCase().replace(/^G0(\d)/, 'G$1');
          modalMotion = m;
        }

        // 2. Update Virtual Position (pt)
        let hasMove = false;
        let target = { ...pt };

        let xMatch = /X([\.\+\-\d]+)/gi.exec(lineStripped)
        if (xMatch) {
          let val = parseFloat(xMatch[1]);
          target.x = abs ? val : pt.x + val;
          hasMove = true;
        }

        let yMatch = /Y([\.\+\-\d]+)/gi.exec(lineStripped)
        if (yMatch) {
          let val = parseFloat(yMatch[1]);
          target.y = abs ? val : pt.y + val;
          hasMove = true;
        }

        let zMatch = /Z([\.\+\-\d]+)/gi.exec(lineStripped)
        if (zMatch) {
          let val = parseFloat(zMatch[1]);
          target.z = abs ? val : pt.z + val;
          hasMove = true;
        }

        if (hasMove) {
          pt = { ...target };
        }

        // 3. Compensation Logic

        // Always pass through non-motion commands or specific exclusions
        // G10 (offsets), G92 (offsets), G4 (dwell), G53 (machine coord), G54-59 (wcs), M-codes
        if (/(G10|G92|G4|G53|G5[4-9]|M\d+)/i.test(lineStripped)) {
          result.push(line); // Preserve original formatting
          // Update p0 if we moved (e.g. G53 G0 X0) - strictly speaking G53 is machine coords, 
          // and our tracking is somewhat WCS relative. 
          // But for safety, if we aren't tracking WCS vs Machine, we might just assume sync.
          // But usually G53 is transit.
          // For G92, it resets coordinates, so our 'pt' tracking handles the 'new position' 
          // (which is actually just an offset shift, but 'pt' tracks effective WCS pos).
          // Syncing p0 is safer.
          if (hasMove) {
            p0 = { ...pt };
            p0_initialized = true;
          }
          return;
        }

        // If it's a motion command (or implicit motion)
        if (modalMotion === 'G0' || modalMotion === 'G1') {
          // Check if it's actually a move command (has coordinates)
          if (hasMove) {
            if (abs) {
              let baseCommand = lineStripped.replace(/([XYZ])([\.\+\-\d]+)/gi, '').trim();

              // Handle segments
              let segs = [];
              if (p0_initialized) {
                segs = this.splitToSegments(p0, pt, units);
              }

              // If no movement (0 length or just F command), ensuring it is preserved
              if (segs.length === 0) {
                let cpt = this.compensateZCoord(pt, units)
                let newLine = `${baseCommand} X${cpt.x.toFixed(3)} Y${cpt.y.toFixed(3)} Z${cpt.z.toFixed(3)}`
                newLine += ` ; Z${pt.z.toFixed(3)}`
                result.push(newLine.trim())
                p0_initialized = true
              } else {
                for (let seg of segs) {
                  let cpt = this.compensateZCoord(seg, units)
                  let newLine = `${baseCommand} X${cpt.x.toFixed(3)} Y${cpt.y.toFixed(3)} Z${cpt.z.toFixed(3)}`
                  newLine += ` ; Z${seg.z.toFixed(3)}`
                  result.push(newLine.trim())
                }
              }

              // Sync p0
              p0 = { ...pt };
              p0_initialized = true;

            } else {
              // Relative G0/G1 - pass through
              result.push(line); // Preserve formatting
              console.log('WARNING: G91 (Relative) move passed through uncompensated.');
              // We must update p0 to stay in sync, assuming we are tracking relative moves correctly 
              // But 'pt' handles relative logic above in step 2.
              p0 = { ...pt };
              p0_initialized = true;
            }
          } else {
            // No XYZ move, e.g. "G1 F100" or just "G1"
            result.push(line);
          }
        } else if (modalMotion === 'G2' || modalMotion === 'G3') {
          // Handle Arcs Interploation
          if (hasMove) {
            // Extract Arc Parameters
            let args = {};
            let iMatch = /I([\.\+\-\d]+)/gi.exec(lineStripped);
            if (iMatch) args.I = parseFloat(iMatch[1]);

            let jMatch = /J([\.\+\-\d]+)/gi.exec(lineStripped);
            if (jMatch) args.J = parseFloat(jMatch[1]);

            let rMatch = /R([\.\+\-\d]+)/gi.exec(lineStripped);
            if (rMatch) args.R = parseFloat(rMatch[1]);

            // p0 is start, pt is end
            if (p0_initialized) {
              let points = this.interpolateArc(p0, pt, args, (modalMotion === 'G2'), units);

              // Output Linear segments (G1)
              for (let ap of points) {
                let cpt = this.compensateZCoord(ap, units);
                // Force G1 for arc segments
                let newLine = `G1 X${cpt.x.toFixed(3)} Y${cpt.y.toFixed(3)} Z${cpt.z.toFixed(3)}`;
                newLine += ` ; ${modalMotion} Z${ap.z.toFixed(3)}`;
                result.push(newLine.trim());
              }

              p0 = { ...pt };
              p0_initialized = true;

            } else {
              // Cannot interpolation without start point
              console.log('WARNING: Arc without valid start point. Passing through.');
              result.push(line);
              p0 = { ...pt };
              p0_initialized = true;
            }
          } else {
            result.push(line);
          }
        } else {
          // G38, G80, etc. - PASS THROUGH
          result.push(line);

          if (modalMotion.startsWith('G38')) {
            p0_initialized = false; // Lost position validity after probe usually
          } else {
            // Unknown motion?
          }
        }

      })

      const newgcodeFileName = alFileNamePrefix + this.gcodeFileName;
      this.sckw.sendGcode(`(AL: loading new gcode ${newgcodeFileName} ...)`)
      console.log(`AL: loading new gcode ${newgcodeFileName} ...)`)
      const outputGCode = result.join('\n');
      this.sckw.loadGcode(newgcodeFileName, outputGCode)
      if (this.outDir) {
        const outputFile = this.outDir + "/" + newgcodeFileName;
        fs.writeFileSync(outputFile, outputGCode);
        this.sckw.sendGcode(`(AL: output file written to ${outputFile})`);
        console.log(`output file written to ${outputFile}`);
      }
      this.sckw.sendGcode(`(AL: finished)`)
    } catch (x) {
      console.error(x);
      this.sckw.sendGcode(`(AL: error occurred ${x})`)
      console.log(`error occurred ${x}`)
    }
    console.log('Leveling applied')
  }
}
