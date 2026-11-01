require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Pool } = require('pg');

const required = ['DATABASE_URL','ADMIN_USERNAME','ADMIN_PASSWORD_HASH','JWT_SECRET'];
for (const key of required) if (!process.env[key]) { console.error(`Missing required environment variable: ${key}`); process.exit(1); }
if (process.env.JWT_SECRET.length < 32) { console.error('JWT_SECRET must contain at least 32 characters.'); process.exit(1); }
const app = express();
const pool = new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_SSL==='true'?{rejectUnauthorized:false}:undefined});
const PORT = Number(process.env.PORT || 10000);
const frontendOrigins = (process.env.FRONTEND_ORIGIN || '').split(',').map(x=>x.trim()).filter(Boolean);
app.use(helmet());
app.use(cors({origin(origin,cb){if(!origin || frontendOrigins.includes(origin))return cb(null,true);return cb(new Error('Origin is not allowed by CORS.'));},methods:['GET','POST','OPTIONS'],allowedHeaders:['Content-Type','Authorization']}));
app.use(express.json({limit:'20kb'}));
app.use('/api',rateLimit({windowMs:60_000,limit:120,standardHeaders:'draft-7',legacyHeaders:false}));
const adminLimiter=rateLimit({windowMs:15*60_000,limit:10,standardHeaders:'draft-7',legacyHeaders:false,message:{error:'Too many login attempts. Try again later.'}});

async function initialize() {
  await pool.query(`CREATE TABLE IF NOT EXISTS games(
    id BIGSERIAL PRIMARY KEY,
    state TEXT NOT NULL DEFAULT 'waiting'
      CHECK(state IN ('waiting','countdown','published')),
    deadline TIMESTAMPTZ,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_game
    ON games(active) WHERE active=TRUE
  `);

  await pool.query(`CREATE TABLE IF NOT EXISTS players(
    id BIGSERIAL PRIMARY KEY,
    game_id BIGINT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    player_id TEXT NOT NULL,
    full_name TEXT NOT NULL,
    telegram_username TEXT NOT NULL,
    group_name CHAR(1) NOT NULL CHECK(group_name IN ('A','B')),
    selected_number INTEGER CHECK(selected_number BETWEEN 1 AND 10),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(game_id,player_id)
  )`);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS unique_group_number
    ON players(game_id,group_name,selected_number)
    WHERE selected_number IS NOT NULL
  `);

  await pool.query(`CREATE TABLE IF NOT EXISTS player_sessions(
    token_hash TEXT PRIMARY KEY,
    player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  // Create an empty game if one does not exist.
  await pool.query(`
    INSERT INTO games(state,active)
    SELECT 'waiting',TRUE
    WHERE NOT EXISTS(
      SELECT 1 FROM games WHERE active=TRUE
    )
  `);

  // Give an older published game a five-minute deadline.
  await pool.query(`
    UPDATE games
    SET deadline = NOW() + INTERVAL '5 minutes'
    WHERE active = TRUE
      AND state = 'published'
      AND deadline IS NULL
  `);
}

async function transaction(fn){const client=await pool.connect();try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(741852963)');const value=await fn(client);await client.query('COMMIT');return value;}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
async function activeGame(db=pool){const r=await db.query('SELECT * FROM games WHERE active=TRUE LIMIT 1');if(!r.rowCount)throw new Error('No active game round.');return r.rows[0];}
async function counts(db,gameId){const r=await db.query(`SELECT group_name,COUNT(*)::int AS total,COUNT(selected_number)::int AS selected FROM players WHERE game_id=$1 GROUP BY group_name`,[gameId]);const out={A:0,B:0,selected:0};for(const row of r.rows){out[row.group_name]=row.total;out.selected+=row.selected;}return out;}

async function finishIfDue() {
  return transaction(async client => {
    const game = await activeGame(client);

    const expired =
      game.deadline &&
      new Date(game.deadline).getTime() <= Date.now();

    if (game.state === 'countdown' && expired) {
      await client.query(
        `UPDATE games
         SET state = 'published',
             deadline = NOW() + INTERVAL '5 minutes'
         WHERE id = $1 AND state = 'countdown'`,
        [game.id]
      );

      return 'published';
    }

    if (game.state === 'published' && expired) {
      await client.query(
        'DELETE FROM games WHERE id = $1',
        [game.id]
      );

      await client.query(
        `INSERT INTO games(state, active)
         VALUES ('waiting', TRUE)`
      );

      return 'reset';
    }

    return game.state;
  });
}

async function publicStatus(){await finishIfDue();const game=await activeGame();const c=await counts(pool,game.id);let secondsRemaining=0;if(game.state==='countdown'&&game.deadline)secondsRemaining=Math.max(0,Math.ceil((new Date(game.deadline).getTime()-Date.now())/1000));return {state:game.state,counts:{A:c.A,B:c.B},total:c.A+c.B,selected:c.selected,secondsRemaining};}
function hashToken(token){return crypto.createHash('sha256').update(token).digest('hex');}
async function requirePlayer(req,res,next){try{const token=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');if(!token)return res.status(401).json({error:'Player login required.'});const r=await pool.query(`SELECT p.* FROM player_sessions s JOIN players p ON p.id=s.player_id JOIN games g ON g.id=p.game_id WHERE s.token_hash=$1 AND g.active=TRUE`,[hashToken(token)]);if(!r.rowCount)return res.status(401).json({error:'Player session is invalid or this round has been reset.'});req.player=r.rows[0];next();}catch(e){next(e);}}
function requireAdmin(req,res,next){try{const token=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');if(!token)return res.status(401).json({error:'Admin login required.'});const data=jwt.verify(token,process.env.JWT_SECRET);if(data.role!=='admin')return res.status(403).json({error:'Admin access required.'});next();}catch(e){return res.status(401).json({error:'Admin session expired. Please log in again.'});}}
app.get('/api/health',(req,res)=>res.json({ok:true}));
app.get('/api/status',async(req,res,next)=>{try{res.json({status:await publicStatus()});}catch(e){next(e);}});
app.post('/api/register',async(req,res,next)=>{try{
 const playerId=String(req.body.playerId||'').trim();const fullName=String(req.body.fullName||'').trim();let telegram=String(req.body.telegramUsername||'').trim().replace(/^@/,'');const group=req.body.group;
 if(!/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_-]{2,20}$/.test(playerId))return res.status(400).json({error:'Player ID must be 2–20 characters and include at least one letter and one number.'});
 if(fullName.length<2||fullName.length>60)return res.status(400).json({error:'Full name must be between 2 and 60 characters.'});
 if(!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(telegram))return res.status(400).json({error:'Enter a valid Telegram username (5–32 characters).'});
 if(!['A','B'].includes(group))return res.status(400).json({error:'Choose Group A or Group B.'});
 const token=crypto.randomBytes(32).toString('hex');const created=await transaction(async client=>{const game=await activeGame(client);if(game.state!=='waiting')throw Object.assign(new Error('This round has already started. Wait for the next round.'),{status:409});const c=await counts(client,game.id);if(c[group]>=5)throw Object.assign(new Error(`Group ${group} is full. Choose the other group if registration is open.`),{status:409});const p=await client.query('INSERT INTO players(game_id,player_id,full_name,telegram_username,group_name) VALUES($1,$2,$3,$4,$5) RETURNING *',[game.id,playerId,fullName,'@'+telegram,group]);await client.query('INSERT INTO player_sessions(token_hash,player_id) VALUES($1,$2)',[hashToken(token),p.rows[0].id]);return p.rows[0];});
 res.status(201).json({token,player:{id:created.id,playerId:created.player_id,fullName:created.full_name,telegramUsername:created.telegram_username,group:created.group_name}});
 }catch(e){if(e.code==='23505')return res.status(409).json({error:'That Player ID is already registered, or that number is already taken.'});next(e);}});
app.post('/api/select',requirePlayer,async(req,res,next)=>{try{const number=Number(req.body.number);if(!Number.isInteger(number)||number<1||number>10)return res.status(400).json({error:'Choose a whole number from 1 to 10.'});const result=await transaction(async client=>{const game=await activeGame(client);if(game.state!=='waiting')throw Object.assign(new Error('Number selection is closed for this round.'),{status:409});const current=await client.query('SELECT * FROM players WHERE id=$1 AND game_id=$2 FOR UPDATE',[req.player.id,game.id]);if(!current.rowCount)throw Object.assign(new Error('Player not found in the active round.'),{status:404});if(current.rows[0].selected_number!==null)throw Object.assign(new Error('You have already submitted your number.'),{status:409});await client.query('UPDATE players SET selected_number=$1 WHERE id=$2',[number,req.player.id]);const c=await counts(client,game.id);if(c.A===5&&c.B===5&&c.selected===10)await client.query("UPDATE games SET state='countdown',deadline=NOW()+INTERVAL '10 seconds' WHERE id=$1",[game.id]);return c;});res.json({ok:true,counts:{A:result.A,B:result.B},selected:result.selected});}catch(e){if(e.code==='23505')return res.status(409).json({error:'That number is already selected in your group. Choose another number.'});next(e);}});

app.get('/api/me', requirePlayer, async (req, res, next) => {
  try {
    const status = await publicStatus();

    const p = await pool.query(
      `SELECT id, game_id, player_id, full_name,
              telegram_username, group_name, selected_number
       FROM players
       WHERE id = $1`,
      [req.player.id]
    );

    if (!p.rowCount) {
      return res.status(404).json({ error: 'Player not found.' });
    }

    const row = p.rows[0];
    let result = null;

    if (status.state === 'published') {
      if (row.selected_number !== null) {
        const opposite = row.group_name === 'A' ? 'B' : 'A';

        const match = await pool.query(
          `SELECT full_name, telegram_username, group_name
           FROM players
           WHERE game_id = $1
             AND group_name = $2
             AND selected_number = $3
           LIMIT 1`,
          [row.game_id, opposite, row.selected_number]
        );

        result = {
          partner: match.rowCount
            ? {
                fullName: match.rows[0].full_name,
                telegramUsername: match.rows[0].telegram_username,
                group: match.rows[0].group_name
              }
            : null
        };
      } else {
        result = { partner: null };
      }
    }

    res.json({
      player: {
        id: row.id,
        playerId: row.player_id,
        fullName: row.full_name,
        telegramUsername: row.telegram_username,
        group: row.group_name,
        hasSelected: row.selected_number !== null
      },
      status,
      result
    });

  } catch (e) {
    next(e);
  }
});

app.post('/api/admin/login',adminLimiter,async(req,res)=>{const username=String(req.body.username||'');const password=String(req.body.password||'');if(username!==process.env.ADMIN_USERNAME||!await bcrypt.compare(password,process.env.ADMIN_PASSWORD_HASH))return res.status(401).json({error:'Invalid admin username or password.'});const token=jwt.sign({role:'admin'},process.env.JWT_SECRET,{expiresIn:'8h'});res.json({token});});
app.get('/api/admin/dashboard',requireAdmin,async(req,res,next)=>{try{const status=await publicStatus();const game=await activeGame();const r=await pool.query('SELECT player_id,full_name,telegram_username,group_name,selected_number FROM players WHERE game_id=$1 ORDER BY group_name,created_at',[game.id]);res.json({status,players:r.rows.map(p=>({playerId:p.player_id,fullName:p.full_name,telegramUsername:p.telegram_username,group:p.group_name,number:p.selected_number}))});}catch(e){next(e);}});
app.post('/api/admin/reset',requireAdmin,async(req,res,next)=>{try{await transaction(async client=>{const game=await activeGame(client);await client.query('DELETE FROM games WHERE id=$1',[game.id]);await client.query("INSERT INTO games(state,active) VALUES('waiting',TRUE)");});res.json({ok:true});}catch(e){next(e);}});
app.use((err,req,res,next)=>{console.error(err);const status=err.status||500;res.status(status).json({error:status===500?'Server error. Check backend logs and database configuration.':err.message});});

(async () => {
  try {
    await initialize();

    // Check for expired games when the server starts.
    await finishIfDue();

    app.listen(PORT, () => {
      console.log(
        `Number Matching Game API listening on port ${PORT}`
      );
    });

    // Automatically check every 5 seconds.
  (async () => {
  try {
    await initialize();
    await finishIfDue();

    app.listen(PORT, () => {
      console.log(`Number Matching Game API listening on port ${PORT}`);
    });
    // Automatically check every 5 seconds.
setInterval(() => {
  console.log('Checking automatic game reset...');

  finishIfDue().catch(error => {
    console.error('Automatic game reset failed:', error);
  });
}, 5000);
      } catch (e) {
    console.error('Backend startup failed:', e);
    process.exit(1);
  }
})();

  
