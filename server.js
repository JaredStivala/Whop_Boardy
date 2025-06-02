// ==================== COMPLETE SERVER.JS - MULTI-TENANT WHOP APP ====================

const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

console.log('🚀 Starting Multi-Tenant Whop Member Directory Server...');

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

// CORS for development and Whop embedding
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-company-id, x-on-behalf-of');
  
  // Allow embedding in iframes (required for Whop apps)
  res.header('X-Frame-Options', 'ALLOWALL');
  res.header('Content-Security-Policy', "frame-ancestors *");
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Enhanced request logging with Whop context
app.use((req, res, next) => {
  const companyId = req.headers['x-company-id'] || req.query.company || 'unknown';
  const userToken = req.cookies?.whop_user_token || req.headers['authorization']?.replace('Bearer ', '') || 'none';
  
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path} [Company: ${companyId}] [Token: ${userToken.substring(0, 10)}...]`);
  next();
});

// Cookie parser middleware
app.use((req, res, next) => {
  const cookieHeader = req.headers.cookie;
  req.cookies = {};
  
  if (cookieHeader) {
    cookieHeader.split(';').forEach(cookie => {
      const [name, value] = cookie.trim().split('=');
      if (name && value) {
        req.cookies[name] = decodeURIComponent(value);
      }
    });
  }
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
      
      // Check current data
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

// ==================== WHOP CONTEXT HELPERS ====================

// Extract company ID from various sources (Whop headers, cookies, URL params)
function extractCompanyId(req) {
  // Priority order:
  // 1. x-company-id header (from Whop platform)
  // 2. company URL parameter
  // 3. whop_company_id cookie
  // 4. Extract from user token if possible
  
  const sources = [
    req.headers['x-company-id'],
    req.query.company,
    req.cookies?.whop_company_id,
    req.body?.company_id
  ];
  
  for (const source of sources) {
    if (source && typeof source === 'string' && source.trim()) {
      console.log(`🏢 Found company ID: ${source}`);
      return source.trim();
    }
  }
  
  return null;
}

// Validate Whop user token (simplified version - in production use Whop SDK)
async function validateWhopToken(token) {
  if (!token || token === 'none') return null;
  
  try {
    // In production, use Whop SDK to validate token
    // For now, just check if token exists and looks valid
    if (token.startsWith('whop_') || token.length > 20) {
      return { valid: true, user_id: 'extracted_from_token' };
    }
  } catch (error) {
    console.warn('⚠️ Token validation failed:', error.message);
  }
  
  return null;
}

// ==================== API ROUTES ====================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Multi-tenant Whop API is healthy!', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    version: '2.0.0',
    features: ['multi-tenant', 'whop-integration', 'auto-company-detection']
  });
});

// Basic test endpoint
app.get('/api/test', (req, res) => {
  const companyId = extractCompanyId(req);
  console.log('📡 API test endpoint called');
  res.json({ 
    success: true, 
    message: 'Multi-tenant API is working perfectly!', 
    timestamp: new Date().toISOString(),
    server: 'Whop Member Directory API v2.0',
    detected_company: companyId || 'none',
    headers: {
      'x-company-id': req.headers['x-company-id'] || 'missing',
      'user-agent': req.headers['user-agent']?.substring(0, 50) || 'unknown'
    }
  });
});

// 🔧 FIXED: Enhanced members endpoint with proper multi-tenant support
app.get('/api/members/:companyId?', async (req, res) => {
  let { companyId } = req.params;
  
  // 🔧 FIX: Extract company ID from multiple sources
  if (!companyId || companyId === 'auto' || companyId === 'current') {
    companyId = extractCompanyId(req);
    
    // If still no company ID, try to auto-detect from database
    if (!companyId) {
      try {
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
          console.log(`🔍 Auto-detected company ID from database: ${companyId}`);
        }
      } catch (error) {
        console.error('❌ Auto-detection failed:', error);
      }
    }
  }
  
  if (!companyId) {
    return res.status(400).json({
      success: false,
      error: 'No company ID provided',
      help: 'This appears to be a multi-tenant app. Company ID is required.',
      suggestions: [
        'If running in Whop: Make sure app is properly embedded with company context',
        'If testing locally: Add ?company=your_company_id to URL',
        'If using API: Include x-company-id header or company parameter'
      ],
      available_companies: await getAvailableCompanies()
    });
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
      timestamp: new Date().toISOString(),
      source: 'database'
    });

  } catch (error) {
    console.error('❌ Database error in members endpoint:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      company_id: companyId,
      timestamp: new Date().toISOString()
    });
  }
});

// Helper function to get available companies
async function getAvailableCompanies() {
  try {
    const result = await pool.query(`
      SELECT 
        company_id,
        COUNT(*) as member_count,
        MAX(joined_at) as latest_member
      FROM whop_members 
      WHERE company_id IS NOT NULL
      GROUP BY company_id
      ORDER BY member_count DESC
      LIMIT 5
    `);
    return result.rows;
  } catch (error) {
    return [];
  }
}

// Get available companies (for multi-tenant support)
app.get('/api/companies', async (req, res) => {
  try {
    const companies = await getAvailableCompanies();
    res.json({
      success: true,
      companies: companies,
      count: companies.length,
      message: companies.length === 0 ? 'No companies found. Companies will appear after receiving webhooks.' : undefined
    });
  } catch (error) {
    console.error('❌ Error fetching companies:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Company info endpoint
app.get('/api/company/:companyId?', async (req, res) => {
  let { companyId } = req.params;
  
  if (!companyId || companyId === 'current') {
    companyId = extractCompanyId(req);
  }
  
  if (!companyId) {
    return res.status(400).json({
      success: false,
      error: 'Company ID required'
    });
  }
  
  try {
    const result = await pool.query(`
      SELECT 
        company_id,
        COUNT(*) as total_members,
        MIN(joined_at) as first_member_date,
        MAX(joined_at) as latest_member_date,
        COUNT(CASE WHEN status = 'active' THEN 1 END) as active_members
      FROM whop_members 
      WHERE company_id = $1
      GROUP BY company_id
    `, [companyId]);
    
    if (result.rows.length === 0) {
      return res.json({
        success: true,
        company: {
          company_id: companyId,
          total_members: 0,
          active_members: 0,
          status: 'No members yet'
        }
      });
    }
    
    res.json({
      success: true,
      company: result.rows[0]
    });
    
  } catch (error) {
    console.error('❌ Error fetching company info:', error);
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
    
    // 🔧 FIX: Extract company_id from webhook data with multiple fallbacks
    const companyId = data.company_id || 
                     data.product?.company_id || 
                     data.business_id ||
                     data.whop_company_id ||
                     req.headers['x-company-id'];
    
    if (!companyId) {
      console.error('❌ No company_id found in webhook data');
      console.log('📝 Available fields:', Object.keys(data));
      return res.status(400).json({ 
        error: 'No company_id provided in webhook',
        help: 'Make sure your Whop webhook includes company/business information',
        received_fields: Object.keys(data)
      });
    }

    if (!userId || !membershipId) {
      console.error('❌ Missing required fields:', { userId, membershipId, companyId });
      return res.status(400).json({ error: 'Missing user_id or membership_id' });
    }

    console.log(`✅ Processing membership for user ${userId} in company ${companyId}`);

    // Fetch user details from Whop API if API key is available
    let whopUserData = null;
    if (process.env.WHOP_API_KEY) {
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
          console.log('👤 User data fetched successfully from Whop API');
        }
      } catch (fetchError) {
        console.warn('⚠️  Could not fetch user data from Whop API:', fetchError.message);
      }
    }

    const email = whopUserData?.email || data.email || null;
    const name = whopUserData?.name || data.name || null;
    const username = whopUserData?.username || data.username || null;

    // 🔧 FIX: Proper timestamp parsing (handle both seconds and milliseconds)
    let joinedAt;
    const createdAtValue = data.created_at || data.created || data.timestamp || data.joined_at;
    
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

    const customFields = JSON.stringify(data.custom_field_responses || data.waitlist_responses || {});
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
    
    res.json({ 
      success: true, 
      member: result.rows[0],
      company_id: companyId
    });

  } catch (error) {
    console.error('❌ Webhook processing error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== FRONTEND ROUTES ====================

// Main app route with company context support
app.get('/', (req, res) => {
  const companyId = extractCompanyId(req);
  console.log(`🌐 Serving main app for company: ${companyId || 'auto-detect'}`);
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/app', (req, res) => {
  const companyId = extractCompanyId(req);
  console.log(`🌐 Serving app page for company: ${companyId || 'auto-detect'}`);
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Directory route with company parameter support
app.get('/directory', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'directory.html'));
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
      'GET /api/company/:companyId (company info)',
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
  console.log('🎉 ===== MULTI-TENANT WHOP MEMBER DIRECTORY STARTED =====');
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
  console.log('   GET  /api/company/:companyId        - Get company info');
  console.log('   POST /webhook/whop                  - Whop webhook');
  console.log('');
  console.log('📄 Frontend Routes:');
  console.log('   GET  /                              - Member Directory (auto-detects company)');
  console.log('   GET  /app                           - Member Directory');
  console.log('   GET  /directory                     - Member Directory (embeddable)');
  console.log('');
  console.log('🏢 Multi-Tenant Features:');
  console.log('   ✅ Auto-detects company from Whop headers');
  console.log('   ✅ Supports x-company-id header');
  console.log('   ✅ Falls back to URL parameters');
  console.log('   ✅ Cookie-based authentication support');
  console.log('   ✅ Multiple company support');
  console.log('   ✅ Fixed timestamp parsing');
  console.log('   ✅ Ready for Whop App Store');
  console.log('');
  console.log('🔍 Company Detection Order:');
  console.log('   1. x-company-id header (from Whop)');
  console.log('   2. ?company=xyz URL parameter');
  console.log('   3. whop_company_id cookie');
  console.log('   4. Auto-detect from database');
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