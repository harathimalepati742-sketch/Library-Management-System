# Library Management System

Node.js + Express backend, plain HTML/CSS/JS frontend.
- **SQL (SQLite):** users, books, borrowals
- **NoSQL (MongoDB):** activity log (optional - app runs without it)

## Run
```
npm install
npm start          # http://localhost:3000
```
Optional: `MONGO_URI` and `JWT_SECRET` environment variables.

## Logins
- Librarian: `librarian` / `admin123` (change it!)
- Demo student: `student1` / `student123` (more students are created by the librarian)

## Rules (edit constants at top of server.js)
14-day loan · +10 points for on-time return · ₹2/day fine when late · max 3 books per student

## Push to GitHub
```
git init && git add . && git commit -m "Library management system"
git branch -M main
git remote add origin <your-repo-url> && git push -u origin main
```

## Deploy on Render (free)
Web Service - Build: `npm install` - Start: `npm start` - env: `JWT_SECRET` (and optional `MONGO_URI`).
Demo note: SQLite resets on restart; sample books and `student1` are re-seeded automatically.
