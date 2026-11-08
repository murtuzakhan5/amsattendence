# Attendance System (Face Recognition)

## Setup
1. Install Node.js (v18+).
2. Install dependencies:
   npm install
3. Download face models (one time):
   npm run download-models
   (On Windows, run it from Git Bash, or copy the files from the GitHub weights folder into public/models.)
4. Start the server:
   npm start

## Pages
- Kiosk (check-in/out):  http://localhost:3000/
- Employees (enroll):    http://localhost:3000/admin.html
- Dashboard (reports):   http://localhost:3000/dashboard.html

Camera works on localhost. For a kiosk on another PC, serve over HTTPS.

## Settings (environment variables, optional)
- PORT=3000
- MATCH_THRESHOLD=0.5   (lower = stricter matching; try 0.45 to 0.6)
- SHIFT_START=09:30     (late arrival after this time)
- TARGET_HOURS=8        (full-day target for progress bars)

Example (Windows PowerShell):  $env:SHIFT_START="10:00"; npm start

## Data
All data is stored in data.json. Back it up regularly.

## Privacy
Face data is biometric. Obtain employee consent and follow local data-protection laws.
