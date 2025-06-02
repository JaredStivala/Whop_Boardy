// ==================== COMPLETE SERVER.JS ====================

const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

console.log('🚀 Starting Whop Member Directory Server...');

// Environment Variables Check
console.log('🔍 Environment Variables Check:');
console.log(`   NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
console.log(`   PORT: ${port}`);
console.log(`   DATABASE_URL: ${process.env.DATABASE_URL ? 'Set' : 'Missing'}`);
console.log(`   WHOP_API_KEY: ${process.env.WHOP_API_KEY ? 'Set' : 'Missing'}`);
console.log(`   WHOP_WEBHOOK_SECRET: ${process.env.WHOP_WEBHOOK_SECRET ? 'Set' : 'Missing'}`);

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS for development
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test database connection
pool.connect()
  .then(client => {
    console.log('✅ Database connected successfully');
    client.release();
  })
  .catch(err => {
    console.error('❌ Database connection error:', err);
    process.exit(1);
  });

// ==================== API ROUTES ====================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    success: true, 
    message: 'API is healthy!', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    version: '1.0.0'
  });
});

// Basic test endpoint
app.get('/api/test', (req, res) => {
  console.log('📡 API test endpoint called');
  res.json({ 
    success: true, 
    message: 'API is working perfectly!', 
    timestamp: new Date().toISOString(),
    server: 'Whop Member Directory API'
  });
});

// Members endpoint
app.get('/api/members/:companyId', async (req, res) => {
  const { companyId } = req.params;
  
  console.log(`🔍 API: Fetching members for company: ${companyId}`);
  
  try {
    const result = await pool.query(`
      SELECT 
        id, user_id, membership_id, email, name, username, 
        custom_fields, joined_at, status
      FROM whop_members 
      WHERE company_id = $1
      ORDER BY joined_at DESC
    `, [companyId]);

    console.log(`✅ Found ${result.rows.length} members in database`);

    const members = result.rows.map(member => {
      let parsedCustomFields = {};
      
      if (member.custom_fields) {
        try {
          if (typeof member.custom_fields === 'string') {
            if (member.custom_fields.includes('ActiveRecord') || member.custom_fields.includes('#<')) {
              parsedCustomFields = {
                status: 'Custom fields detected',
                note: 'Upgrade Whop app permissions to see details'
              };
            } else {
              parsedCustomFields = JSON.parse(member.custom_fields);
            }
          } else {
            parsedCustomFields = member.custom_fields;
          }
        } catch (e) {
          parsedCustomFields = {
            error: 'Unable to parse custom fields',
            note: 'Custom field data exists but in an unsupported format'
          };
        }
      }

      return {
        id: member.id,
        user_id: member.user_id,
        membership_id: member.membership_id,
        email: member.email,
        name: member.name,
        username: member.username,
        waitlist_responses: parsedCustomFields,
        custom_fields: parsedCustomFields,
        joined_at: member.joined_at,
        status: member.status
      };
    });

    res.json({
      success: true,
      members: members,
      count: members.length,
      company_id: companyId,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Database error in members endpoint:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Debug endpoint
app.get('/api/debug-members/:companyId', async (req, res) => {
  try {
    const { companyId } = req.params;
    
    const result = await pool.query(`
      SELECT 
        id, user_id, name, username, email, custom_fields, joined_at
      FROM whop_members 
      WHERE company_id = $1
      ORDER BY joined_at DESC
      LIMIT 10
    `, [companyId]);

    console.log('🔍 Debug: Raw database results:');
    result.rows.forEach((row, index) => {
      console.log(`   Member ${index + 1}:`, {
        id: row.id,
        user_id: row.user_id,
        name: row.name,
        username: row.username,
        email: row.email,
        custom_fields_type: typeof row.custom_fields,
        joined_at: row.joined_at
      });
    });

    res.json({
      success: true,
      debug: 'Check server logs for detailed member data',
      count: result.rows.length,
      members: result.rows
    });

  } catch (error) {
    console.error('❌ Debug endpoint error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== WEBHOOK ENDPOINT ====================

app.post('/webhook/whop', async (req, res) => {
  try {
    console.log('🎯 Webhook received from Whop');
    
    const { data, event_type } = req.body;

    if (!data) {
      return res.status(400).json({ error: 'No data provided' });
    }

    const userId = data.user_id || data.user;
    const membershipId = data.id || data.membership_id;
    const companyId = data.company_id || 'biz_6GuEa8lMu5p9yl';

    if (!userId || !membershipId) {
      return res.status(400).json({ error: 'Missing user_id or membership_id' });
    }

    console.log(`✅ Processing membership for user ${userId}`);

    // Fetch user details from Whop API
    let whopUserData = null;
    try {
      const userResponse = await fetch(`https://api.whop.com/api/v5/app/users/${userId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${process.env.WHOP_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      if (userResponse.ok) {
        whopUserData = await userResponse.json();
        console.log('👤 User data fetched successfully');
      }
    } catch (fetchError) {
      console.warn('⚠️  Could not fetch user data from Whop API');
    }

    const email = whopUserData?.email || data.email || null;
    const name = whopUserData?.name || data.name || null;
    const username = whopUserData?.username || data.username || null;

    // Store in database
    const insertQuery = `
      INSERT INTO whop_members (
        user_id, membership_id, company_id, email, name, username, 
        custom_fields, joined_at, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (user_id, company_id) 
      DO UPDATE SET 
        membership_id = EXCLUDED.membership_id,
        email = EXCLUDED.email,
        name = EXCLUDED.name,
        username = EXCLUDED.username,
        custom_fields = EXCLUDED.custom_fields,
        status = EXCLUDED.status
      RETURNING *;
    `;

    const customFields = JSON.stringify(data.custom_field_responses || {});
    const joinedAt = new Date(data.created_at || Date.now());
    const status = data.status || 'active';

    const result = await pool.query(insertQuery, [
      userId, membershipId, companyId, email, name, username,
      customFields, joinedAt, status
    ]);

    console.log('🎉 Member stored successfully');
    res.json({ success: true, member: result.rows[0] });

  } catch (error) {
    console.error('❌ Webhook processing error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== FRONTEND ROUTES ====================

// Main app route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 404 handler for API routes
app.use('/api/*', (req, res) => {
  console.log(`❌ API route not found: ${req.method} ${req.path}`);
  res.status(404).json({ 
    error: 'API endpoint not found',
    path: req.path,
    method: req.method,
    available_endpoints: [
      'GET /api/test',
      'GET /api/health',
      'GET /api/members/:companyId',
      'GET /api/debug-members/:companyId',
      'POST /webhook/whop'
    ]
  });
});

// Catch-all for SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== START SERVER ====================

app.listen(port, () => {
  console.log('');
  console.log('🎉 ===== SERVER STARTED SUCCESSFULLY =====');
  console.log(`🚀 Server running on port ${port}`);
  console.log(`📱 App URL: https://whopboardy-production.up.railway.app/`);
  console.log(`🔗 Webhook URL: https://whopboardy-production.up.railway.app/webhook/whop`);
  console.log('');
  console.log('🔧 Available API Endpoints:');
  console.log('   GET  /api/test                     - Basic API test');
  console.log('   GET  /api/health                   - Health check');
  console.log('   GET  /api/members/:companyId       - Get members');
  console.log('   GET  /api/debug-members/:companyId - Debug members');
  console.log('   POST /webhook/whop                 - Whop webhook');
  console.log('');
  console.log('📄 Frontend Routes:');
  console.log('   GET  /                             - Member Directory');
  console.log('   GET  /app                          - Member Directory');
  console.log('');
});

// Error handling
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  pool.end(() => {
    console.log('Database pool closed');
    process.exit(0);
  });
});

module.exports = app;