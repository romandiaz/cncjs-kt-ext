
class Mesh {
    constructor(points) {
        // points: array of {x, y, z}
        this.grid = [];

        if (!points || points.length === 0) {
            return;
        }

        // 1. Sort points to normalize Zigzag -> Raster and handle random order
        // Sort by Y (primary) and X (secondary)
        // Use a small epsilon for Y comparison to group rows
        const epsilon = 0.001;

        // Clone to avoid mutating original
        const sorted = [...points].sort((a, b) => {
            if (Math.abs(a.y - b.y) > epsilon) {
                return a.y - b.y;
            }
            return a.x - b.x;
        });

        // 2. Group into rows
        let currentRow = [];
        let lastY = sorted[0].y;

        for (const pt of sorted) {
            /* If the Y difference is significant, we've started a new row.
               However, be careful with the first point. 
               We initialize lastY with sorted[0].y, so the first point is always close.
            */
            if (Math.abs(pt.y - lastY) > epsilon) {
                // New row detected
                if (currentRow.length > 0) {
                    this.grid.push(currentRow);
                }
                currentRow = [];
                lastY = pt.y; // Update row Y reference
            }
            currentRow.push(pt);
        }
        // Push the final row
        if (currentRow.length > 0) {
            this.grid.push(currentRow);
        }

        // 3. Validation
        if (this.grid.length < 2) {
            // Not enough rows for bilinear
            // console.warn("Mesh: Warning - Less than 2 rows, cannot interpolate 2D plane properly.");
            // Proceeding might be dangerous, but we'll let interpolateZ handle it by returning 0 or fallback.
        }

        // Ensure consistent column counts for simple bilinear logic
        // If irregular, we might assume the "Row X" logic matches roughly. 
        // For robustness, we won't strictly enforce equal lengths if not needed, 
        // but our lookup logic relies on `rowLow[c]` and `rowGt[c]` lining up? 
        // Actually, simple grid assumption implies row[i] and row[i+1] have aligned X coords.
        // If not aligned (e.g. shift), we are doing trapezoidal or generic quad interpolation.
        // The standard logic assumes a strict grid.
        // We will assume X coords align by index for now as that's how we probe.
    }

    /**
     * Get Z at (x,y) using bilinear interpolation
     */
    interpolateZ(x, y) {
        if (this.grid.length === 0) return 0;
        if (this.grid.length === 1) return this.grid[0][0].z; // Fallback for single point/row

        // 1. Find Row Index (r)
        // We look for the row interval [row_r, row_{r+1}] containing y
        let r = 0;

        // Clamp Y to grid bounds
        const startY = this.grid[0][0].y;
        const endY = this.grid[this.grid.length - 1][0].y;

        if (y <= startY) {
            r = 0;
        } else if (y >= endY) {
            r = this.grid.length - 2;
        } else {
            // Linear search for interval
            for (let i = 0; i < this.grid.length - 1; i++) {
                const rY = this.grid[i][0].y;
                const nextRY = this.grid[i + 1][0].y;
                if (y >= rY && y <= nextRY) {
                    r = i;
                    break;
                }
            }
        }

        const rowLow = this.grid[r];
        const rowHi = this.grid[r + 1];

        if (!rowLow || !rowHi) return this.grid[0][0].z; // Should not happen given checks

        // 2. Find Column Index (c) within the row
        // We assume rowLow and rowHi have essentially the same X coordinates.
        // We use rowLow for X search.

        let c = 0;
        const startX = rowLow[0].x;
        const endX = rowLow[rowLow.length - 1].x;

        if (x <= startX) {
            c = 0;
        } else if (x >= endX) {
            c = rowLow.length - 2;
        } else {
            for (let i = 0; i < rowLow.length - 1; i++) {
                const cX = rowLow[i].x;
                const nextCX = rowLow[i + 1].x;
                if (x >= cX && x <= nextCX) {
                    c = i;
                    break;
                }
            }
        }

        // Safety for short rows
        if (c >= rowLow.length - 1) c = rowLow.length - 2;
        if (c < 0) c = 0;

        // 3. Get the 4 points
        // p00 -- p10 (Bottom row)
        // p01 -- p11 (Top row) 
        // Note: standard notation usually (x,y). 
        // Let's use Q11, Q21, Q12, Q22 notation from Wikipedia or similar.
        // Q11 = (x1, y1) = rowLow[c]
        // Q21 = (x2, y1) = rowLow[c+1]
        // Q12 = (x1, y2) = rowHi[c]
        // Q22 = (x2, y2) = rowHi[c+1]

        // Check availability
        if (!rowHi[c] || !rowHi[c + 1]) {
            // Grid might be jagged. Fallback to nearest neighbor or simple interpolation on rowLow.
            // For now, return simple average or just Q11
            return rowLow[c].z;
        }

        const Q11 = rowLow[c];
        const Q21 = rowLow[c + 1];
        const Q12 = rowHi[c];
        const Q22 = rowHi[c + 1];

        // 4. Interpolate
        const x1 = Q11.x;
        const x2 = Q21.x;
        const y1 = Q11.y;
        const y2 = Q12.y; // Should match Q22.y roughly

        // Calculate normalized coordinates (0..1)
        // Guard against div/0
        const spanX = x2 - x1;
        const spanY = y2 - y1;

        if (Math.abs(spanX) < 1e-9 && Math.abs(spanY) < 1e-9) return Q11.z;
        if (Math.abs(spanX) < 1e-9) {
            // Vertical line, linear interp on Y
            const t = (y - y1) / spanY;
            return Q11.z * (1 - t) + Q12.z * t;
        }
        if (Math.abs(spanY) < 1e-9) {
            // Horizontal line, linear interp on X
            const t = (x - x1) / spanX;
            return Q11.z * (1 - t) + Q21.z * t;
        }

        // Standard Bilinear
        // f(x,y) ≈ ...
        // Let's use the unit square lerp approach for simplicity and stability
        const u = (x - x1) / spanX;
        const v = (y - y1) / spanY;

        // Lerp on bottom edge
        const zBottom = Q11.z * (1 - u) + Q21.z * u;
        // Lerp on top edge
        const zTop = Q12.z * (1 - u) + Q22.z * u;
        // Lerp between them
        const zFinal = zBottom * (1 - v) + zTop * v;

        return zFinal;
    }
}

module.exports = Mesh;
