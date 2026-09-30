const express = require('express'), Database = require('better-sqlite3'), bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken'), { MongoClient } = require('mongodb');

const SECRET = process.env.JWT_SECRET || 'change-me', LOAN_DAYS = 14, REWARD = 10, FINE_PER_DAY = 2, MAX_LOANS = 3;

// ---------- SQL (SQLite): users, books, borrowals ----------
const db = new Database('library.db');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, username TEXT UNIQUE, password TEXT,
  role TEXT CHECK(role IN('student','librarian')), points INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS books(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, author TEXT, section TEXT, total INTEGER, available INTEGER);
CREATE TABLE IF NOT EXISTS borrowals(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, book_id INTEGER,
  borrowed_on TEXT, due_on TEXT, returned_on TEXT, fine INTEGER DEFAULT 0);`);
if (!db.prepare("SELECT 1 FROM users WHERE role='librarian'").get())
  db.prepare('INSERT INTO users(name,username,password,role) VALUES(?,?,?,?)')
    .run('Librarian', 'librarian', bcrypt.hashSync('admin123', 10), 'librarian');

// ---------- NoSQL (MongoDB): activity log ----------
let logs = null;
MongoClient.connect(process.env.MONGO_URI || 'mongodb://localhost:27017')
  .then(c => { logs = c.db('library').collection('activity'); console.log('MongoDB connected'); })
  .catch(() => console.log('MongoDB not available - activity log disabled'));
const log = (type, detail) => logs && logs.insertOne({ type, detail, at: new Date() }).catch(() => {});

// ---------- helpers ----------
const day = d => d.toISOString().slice(0, 10);
const auth = role => (req, res, next) => {
  try {
    const u = jwt.verify((req.headers.authorization || '').split(' ')[1], SECRET);
    if (role && u.role !== role) return res.status(403).json({ error: 'Forbidden' });
    req.user = u; next();
  } catch { res.status(401).json({ error: 'Please log in' }); }
};

const app = express();
app.use(express.json(), express.static('public'));

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!u || !bcrypt.compareSync(password || '', u.password)) return res.status(400).json({ error: 'Invalid credentials' });
  res.json({ token: jwt.sign({ id: u.id, role: u.role, name: u.name }, SECRET, { expiresIn: '8h' }), user: { name: u.name, role: u.role } });
});

// ---------- books ----------
app.get('/api/books', auth(), (_, res) => res.json(db.prepare('SELECT * FROM books ORDER BY section,title').all()));
app.post('/api/books', auth('librarian'), (req, res) => {
  const { title, author, section, total } = req.body, n = parseInt(total) || 1;
  if (!title || !section) return res.status(400).json({ error: 'Title and section required' });
  db.prepare('INSERT INTO books(title,author,section,total,available) VALUES(?,?,?,?,?)').run(title, author, section, n, n);
  log('book_added', { title, section, copies: n }); res.json({ ok: true });
});
app.delete('/api/books/:id', auth('librarian'), (req, res) => {
  if (db.prepare('SELECT 1 FROM borrowals WHERE book_id=? AND returned_on IS NULL').get(req.params.id))
    return res.status(400).json({ error: 'Book is currently borrowed' });
  db.prepare('DELETE FROM books WHERE id=?').run(req.params.id);
  log('book_removed', { id: req.params.id }); res.json({ ok: true });
});
app.get('/api/stats', auth('librarian'), (_, res) => res.json(db.prepare(
  'SELECT section, COUNT(*) titles, SUM(total) total, SUM(available) available FROM books GROUP BY section').all()));

// ---------- students ----------
app.get('/api/students', auth('librarian'), (_, res) =>
  res.json(db.prepare("SELECT id,name,username,points FROM users WHERE role='student'").all()));
app.post('/api/students', auth('librarian'), (req, res) => {
  const { name, username, password } = req.body;
  if (!name || !username || !password) return res.status(400).json({ error: 'All fields required' });
  try { db.prepare("INSERT INTO users(name,username,password,role) VALUES(?,?,?,'student')").run(name, username, bcrypt.hashSync(password, 10)); }
  catch { return res.status(400).json({ error: 'Username already exists' }); }
  log('student_added', { username }); res.json({ ok: true });
});
app.delete('/api/students/:id', auth('librarian'), (req, res) => {
  if (db.prepare('SELECT 1 FROM borrowals WHERE user_id=? AND returned_on IS NULL').get(req.params.id))
    return res.status(400).json({ error: 'Student has unreturned books' });
  db.prepare('DELETE FROM borrowals WHERE user_id=?').run(req.params.id);
  db.prepare("DELETE FROM users WHERE id=? AND role='student'").run(req.params.id);
  log('student_removed', { id: req.params.id }); res.json({ ok: true });
});

// ---------- borrow / return ----------
app.post('/api/borrow/:bookId', auth('student'), (req, res) => {
  const book = db.prepare('SELECT * FROM books WHERE id=?').get(req.params.bookId);
  if (!book || book.available < 1) return res.status(400).json({ error: 'Book not available' });
  if (db.prepare('SELECT COUNT(*) c FROM borrowals WHERE user_id=? AND returned_on IS NULL').get(req.user.id).c >= MAX_LOANS)
    return res.status(400).json({ error: `Max ${MAX_LOANS} books at a time` });
  const now = new Date(), due = new Date(now.getTime() + LOAN_DAYS * 864e5);
  db.transaction(() => {
    db.prepare('UPDATE books SET available=available-1 WHERE id=?').run(book.id);
    db.prepare('INSERT INTO borrowals(user_id,book_id,borrowed_on,due_on) VALUES(?,?,?,?)').run(req.user.id, book.id, day(now), day(due));
  })();
  log('borrowed', { student: req.user.name, book: book.title, due: day(due) });
  res.json({ msg: `Borrowed! Return by ${day(due)}` });
});
app.post('/api/return/:id', auth('student'), (req, res) => {
  const b = db.prepare('SELECT * FROM borrowals WHERE id=? AND user_id=? AND returned_on IS NULL').get(req.params.id, req.user.id);
  if (!b) return res.status(404).json({ error: 'Borrowal not found' });
  const late = Math.max(0, Math.floor((Date.now() - new Date(b.due_on)) / 864e5)), fine = late * FINE_PER_DAY, pts = late ? 0 : REWARD;
  db.transaction(() => {
    db.prepare('UPDATE borrowals SET returned_on=?, fine=? WHERE id=?').run(day(new Date()), fine, b.id);
    db.prepare('UPDATE books SET available=available+1 WHERE id=?').run(b.book_id);
    db.prepare('UPDATE users SET points=points+? WHERE id=?').run(pts, req.user.id);
  })();
  log(late ? 'fine' : 'reward', { student: req.user.name, fine, points: pts });
  res.json({ msg: late ? `Returned ${late} day(s) late. Fine: ₹${fine}` : `Returned on time! +${REWARD} reward points 🎉` });
});
app.get('/api/my', auth('student'), (req, res) => res.json({
  points: db.prepare('SELECT points FROM users WHERE id=?').get(req.user.id).points,
  loans: db.prepare('SELECT b.*, k.title FROM borrowals b JOIN books k ON k.id=b.book_id WHERE b.user_id=? ORDER BY b.id DESC').all(req.user.id)
}));
app.get('/api/borrowals', auth('librarian'), (_, res) => res.json(db.prepare(
  'SELECT b.*, u.name student, k.title FROM borrowals b JOIN users u ON u.id=b.user_id JOIN books k ON k.id=b.book_id ORDER BY b.id DESC').all()));
app.get('/api/logs', auth('librarian'), async (_, res) =>
  res.json(logs ? await logs.find().sort({ at: -1 }).limit(30).toArray() : []));

app.listen(3000, () => console.log('Running at http://localhost:3000'));
