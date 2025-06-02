// ==================== COMPLETE SERVER.JS - FIXED VERSION ====================

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

// Database connection and table creation
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test database connection and create tables
pool.connect()
  .then(async (client) => {
    console.log('✅ Database connected successfully');
    
    // Create tables if they don't exist (with proper multi-tenant support)
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS whop_members (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(255) NOT NULL,
          membership_id VARCHAR(255),
          company_id VARCHAR(255) NOT NULL,
          email VARCHAR(255),
          name VARCHAR(255),
          username VARCHAR(255),
          profile_picture_url TEXT,
          custom_fields JSONB,
          joined_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          status VARCHAR(50) DEFAULT 'active',
          UNIQUE(user_id, company_id)
        );
        
        -- Create indexes for better performance
        CREATE INDEX IF NOT EXISTS idx_whop_members_company_id ON whop_members(company_id);
        CREATE INDEX IF NOT EXISTS idx_whop_members_user_id ON whop_members(user_id);
        CREATE INDEX IF NOT EXISTS idx_whop_members_joined_at ON whop_members(joined_at);
        CREATE INDEX IF NOT EXISTS idx_whop_members_status ON whop_members(status);
        
        -- Add updated_at column if it doesn't exist
        ALTER TABLE whop_members 
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
        
        -- Create trigger to automatically update updated_at
        CREATE OR REPLACE FUNCTION update_updated_at_column()
        RETURNS TRIGGER AS $$
        BEGIN
          NEW.updated_at = CURRENT_TIMESTAMP;
          RETURN NEW;
        END;
        $$ language 'plpgsql';
        
        DROP TRIGGER IF EXISTS update_whop_members_updated_at ON whop_members;
        CREATE TRIGGER update_whop_members_updated_at
          BEFORE UPDATE ON whop_members
          FOR EACH ROW
          EXECUTE FUNCTION update_updated_at_column();
      `);
      
      console.log('✅ Database tables and indexes created successfully');
      
      // Check current data and fix any timestamp issues
      const countResult = await client.query(`
        SELECT 
          company_id,
          COUNT(*) as total_members,
          COUNT(CASE WHEN joined_at < '2020-01-01' THEN 1 END) as invalid_dates
        FROM whop_members 
        GROUP BY company_id
      `);
      
      if (countResult.rows.length > 0) {
        console.log('📊 Current database status:');
        countResult.rows.forEach(row => {
          console.log(`   Company ${row.company_id}: ${row.total_members} members (${row.invalid_dates} with invalid dates)`);
        });
        
        // Fix invalid timestamps (dates before 2020)
        const fixResult = await client.query(`
          UPDATE whop_members 
          SET joined_at = updated_at 
          WHERE joined_at < '2020-01-01' AND updated_at >= '2020-01-01'
        `);
        
        if (fixResult.rowCount > 0) {
          console.log(`🔧 Fixed ${fixResult.rowCount} invalid timestamps`);
        }
      }
      
    } catch (createError) {
      console.error('❌ Error creating database tables:', createError);
    }
    
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

// Members endpoint - now supports dynamic company detection
app.get('/api/members/:companyId?', async (req, res) => {
  let { companyId } = req.params;
  
  // 🔧 FIX: Auto-detect company ID if not provided
  if (!companyId || companyId === 'auto') {
    try {
      // Try to get the most recent company from database
      const recentCompanyResult = await pool.query(`
        SELECT DISTINCT company_id, COUNT(*) as member_count
        FROM whop_members 
        WHERE company_id IS NOT NULL
        GROUP BY company_id
        ORDER BY member_count DESC, MAX(joined_at) DESC
        LIMIT 1
      `);
      
      if (recentCompanyResult.rows.length > 0) {
        companyId = recentCompanyResult.rows[0].company_id;
        console.log(`🔍 Auto-detected company ID: ${companyId}`);
      } else {
        return res.status(400).json({
          success: false,
          error: 'No company ID provided and no companies found in database',
          help: 'Provide a company ID in the URL: /api/members/your_company_id'
        });
      }
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: 'Failed to auto-detect company ID'
      });
    }
  }
  
  console.log(`🔍 API: Fetching members for company: ${companyId}`);
  
  try {
    const result = await pool.query(`
      SELECT 
        id, user_id, membership_id, email, name, username, 
        custom_fields, joined_at, status, updated_at
      FROM whop_members 
      WHERE company_id = $1
      ORDER BY joined_at DESC
    `, [companyId]);

    console.log(`✅ Found ${result.rows.length} members in database for company ${companyId}`);

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
        status: member.status,
        updated_at: member.updated_at
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

// Get available companies (for multi-tenant support)
app.get('/api/companies', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        company_id,
        COUNT(*) as member_count,
        MAX(joined_at) as latest_member,
        MIN(joined_at) as first_member
      FROM whop_members 
      WHERE company_id IS NOT NULL
      GROUP BY company_id
      ORDER BY member_count DESC, latest_member DESC
    `);

    res.json({
      success: true,
      companies: result.rows,
      count: result.rows.length
    });

  } catch (error) {
    console.error('❌ Error fetching companies:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Fix timestamp issues endpoint
app.post('/api/fix-timestamps', async (req, res) => {
  try {
    console.log('🔧 Starting timestamp fix process...');
    
    // Find members with invalid timestamps (before 2020)
    const invalidResult = await pool.query(`
      SELECT id, user_id, company_id, joined_at, updated_at
      FROM whop_members 
      WHERE joined_at < '2020-01-01'
      ORDER BY company_id, id
    `);
    
    console.log(`Found ${invalidResult.rows.length} members with invalid timestamps`);
    
    let fixedCount = 0;
    const fixes = [];
    
    for (const member of invalidResult.rows) {
      // Use updated_at if it's valid, otherwise use current timestamp
      const newTimestamp = member.updated_at && member.updated_at >= new Date('2020-01-01') 
        ? member.updated_at 
        : new Date();
      
      await pool.query(`
        UPDATE whop_members 
        SET joined_at = $1 
        WHERE id = $2
      `, [newTimestamp, member.id]);
      
      fixedCount++;
      fixes.push({
        user_id: member.user_id,
        company_id: member.company_id,
        old_date: member.joined_at,
        new_date: newTimestamp
      });
      
      console.log(`✅ Fixed timestamp for user ${member.user_id}: ${member.joined_at} → ${newTimestamp}`);
    }
    
    res.json({
      success: true,
      message: `Fixed ${fixedCount} invalid timestamps`,
      fixes: fixes,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Error fixing timestamps:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Diagnostic endpoint to check data quality
app.get('/api/diagnostics/:companyId?', async (req, res) => {
  try {
    const { companyId } = req.params;
    
    let whereClause = '';
    let params = [];
    
    if (companyId && companyId !== 'all') {
      whereClause = 'WHERE company_id = $1';
      params = [companyId];
    }
    
    const diagnostics = {};
    
    // Basic statistics
    const statsResult = await pool.query(`
      SELECT 
        company_id,
        COUNT(*) as total_members,
        COUNT(CASE WHEN joined_at < '2020-01-01' THEN 1 END) as invalid_dates,
        COUNT(CASE WHEN joined_at >= '2020-01-01' THEN 1 END) as valid_dates,
        MIN(joined_at) as earliest_date,
        MAX(joined_at) as latest_date,
        COUNT(CASE WHEN email IS NOT NULL THEN 1 END) as members_with_email,
        COUNT(CASE WHEN username IS NOT NULL THEN 1 END) as members_with_username,
        COUNT(CASE WHEN custom_fields IS NOT NULL THEN 1 END) as members_with_custom_fields
      FROM whop_members 
      ${whereClause}
      GROUP BY company_id
      ORDER BY total_members DESC
    `, params);
    
    diagnostics.statistics = statsResult.rows;
    
    // Custom fields analysis
    const customFieldsResult = await pool.query(`
      SELECT 
        company_id,
        COUNT(CASE WHEN custom_fields::text LIKE '%ActiveRecord%' THEN 1 END) as activerecord_fields,
        COUNT(CASE WHEN custom_fields::text NOT LIKE '%ActiveRecord%' AND custom_fields IS NOT NULL THEN 1 END) as parsed_fields,
        COUNT(CASE WHEN custom_fields IS NULL THEN 1 END) as no_custom_fields
      FROM whop_members 
      ${whereClause}
      GROUP BY company_id
    `, params);
    
    diagnostics.custom_fields = customFieldsResult.rows;
    
    // Sample problematic records
    const problemsResult = await pool.query(`
      SELECT 
        id, user_id, company_id, joined_at, email, username,
        CASE 
          WHEN joined_at < '2020-01-01' THEN 'Invalid timestamp'
          WHEN email IS NULL AND username IS NULL THEN 'Missing identifiers'
          ELSE 'OK'
        END as issue
      FROM whop_members 
      ${whereClause}
      WHERE joined_at < '2020-01-01' OR (email IS NULL AND username IS NULL)
      ORDER BY joined_at ASC
      LIMIT 10
    `, params);
    
    diagnostics.sample_issues = problemsResult.rows;
    
    res.json({
      success: true,
      diagnostics: diagnostics,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Error running diagnostics:', error);
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
    console.log('📦 Full webhook payload:', JSON.stringify(req.body, null, 2));
    
    const { data, event_type } = req.body;

    if (!data) {
      return res.status(400).json({ error: 'No data provided' });
    }

    const userId = data.user_id || data.user;
    const membershipId = data.id || data.membership_id;
    
    // 🔧 FIX: Extract company_id from webhook data (not hardcoded)
    const companyId = data.company_id || data.product?.company_id || data.business_id;
    
    if (!companyId) {
      console.error('❌ No company_id found in webhook data');
      return res.status(400).json({ 
        error: 'No company_id provided in webhook',
        help: 'Make sure your Whop webhook includes company/business information'
      });
    }

    if (!userId || !membershipId) {
      console.error('❌ Missing required fields:', { userId, membershipId, companyId });
      return res.status(400).json({ error: 'Missing user_id or membership_id' });
    }

    console.log(`✅ Processing membership for user ${userId} in company ${companyId}`);

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

    // 🔧 FIX: Proper timestamp parsing (handle both seconds and milliseconds)
    let joinedAt;
    const createdAtValue = data.created_at || data.created || data.timestamp;
    
    if (createdAtValue) {
      // Check if timestamp is in milliseconds (> year 2000 in seconds)
      const timestamp = parseInt(createdAtValue);
      if (timestamp > 946684800) { // Jan 1, 2000 in seconds
        if (timestamp > 946684800000) {
          // Timestamp is in milliseconds
          joinedAt = new Date(timestamp);
        } else {
          // Timestamp is in seconds
          joinedAt = new Date(timestamp * 1000);
        }
      } else {
        // Try parsing as ISO string
        joinedAt = new Date(createdAtValue);
      }
      
      // Validate the parsed date
      if (isNaN(joinedAt.getTime()) || joinedAt.getFullYear() < 2020) {
        console.warn(`⚠️  Invalid timestamp ${createdAtValue}, using current time`);
        joinedAt = new Date();
      }
    } else {
      joinedAt = new Date();
    }

    console.log(`📅 Parsed join date: ${joinedAt.toISOString()} (from: ${createdAtValue})`);

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
        status = EXCLUDED.status,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *;
    `;

    const customFields = JSON.stringify(data.custom_field_responses || {});
    const status = data.status || 'active';

    const result = await pool.query(insertQuery, [
      userId, membershipId, companyId, email, name, username,
      customFields, joinedAt, status
    ]);

    console.log('🎉 Member stored successfully:', {
      user_id: userId,
      company_id: companyId,
      joined_at: joinedAt.toISOString(),
      status: status
    });
    
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
      'GET /api/members/auto (auto-detect company)',
      'GET /api/members/:companyId',
      'GET /api/companies (list all companies)',
      'GET /api/diagnostics/:companyId (data quality check)',
      'POST /api/fix-timestamps (fix invalid dates)',
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
  console.log('🎉 ===== WHOP MEMBER DIRECTORY STARTED =====');
  console.log(`🚀 Server running on port ${port}`);
  console.log(`📱 App URL: https://whopboardy-production.up.railway.app/`);
  console.log(`🔗 Webhook URL: https://whopboardy-production.up.railway.app/webhook/whop`);
  console.log('');
  console.log('🔧 API Endpoints:');
  console.log('   GET  /api/test                      - Basic API test');
  console.log('   GET  /api/health                    - Health check');
  console.log('   GET  /api/members/auto              - Auto-detect company members');
  console.log('   GET  /api/members/:companyId        - Get members for specific company');
  console.log('   GET  /api/companies                 - List all companies');
  console.log('   GET  /api/diagnostics/:companyId    - Data quality diagnostics');
  console.log('   POST /api/fix-timestamps            - Fix invalid timestamps');
  console.log('   POST /webhook/whop                  - Whop webhook');
  console.log('');
  console.log('📄 Frontend Routes:');
  console.log('   GET  /                              - Member Directory (auto-detects company)');
  console.log('   GET  /app                           - Member Directory');
  console.log('');
  console.log('🏢 Multi-Tenant Features:');
  console.log('   ✅ Auto-detects company from webhook data');
  console.log('   ✅ Supports multiple communities');
  console.log('   ✅ Fixed timestamp parsing (no more 1970 dates!)');
  console.log('   ✅ Ready for Whop App Store distribution');
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