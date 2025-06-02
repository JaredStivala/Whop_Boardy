// ==================== FIXED SERVER.JS - AUTO-DETECTING WHOP APP ====================

const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

console.log('🚀 Starting Auto-Detecting Whop Member Directory Server...');

// Environment Variables Check
console.log('🔍 Environment Variables Check:');
console.log(`   NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
console.log(`   PORT: ${port}`);
console.log(`   DATABASE_URL: ${process.env.DATABASE_URL ? 'Set' : 'Missing'}`);

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS for Whop embedding
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-company-id, x-whop-company-id, x-business-id');
  
  // Allow embedding in Whop iframes
  res.header('X-Frame-Options', 'ALLOWALL');
  res.header('Content-Security-Policy', "frame-ancestors *");
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Enhanced request logging
app.use((req, res, next) => {
  const companyId = extractCompanyId(req);
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path} [Company: ${companyId || 'auto-detect'}]`);
  next();
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database
pool.connect()
  .then(async (client) => {
    console.log('✅ Database connected successfully');
    
    try {
      // Create companies table for installations
      await client.query(`
        CREATE TABLE IF NOT EXISTS whop_companies (
          id SERIAL PRIMARY KEY,
          company_id VARCHAR(255) UNIQUE NOT NULL,
          company_name VARCHAR(255),
          installed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          last_activity TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          webhook_secret VARCHAR(500),
          settings JSONB DEFAULT '{}',
          status VARCHAR(50) DEFAULT 'active'
        );
        
        CREATE INDEX IF NOT EXISTS idx_whop_companies_company_id ON whop_companies(company_id);
      `);
      
      // Create or update members table
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
          custom_fields JSONB DEFAULT '{}',
          joined_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          status VARCHAR(50) DEFAULT 'active',
          UNIQUE(user_id, company_id),
          FOREIGN KEY (company_id) REFERENCES whop_companies(company_id) ON DELETE CASCADE
        );
        
        CREATE INDEX IF NOT EXISTS idx_whop_members_company_id ON whop_members(company_id);
        CREATE INDEX IF NOT EXISTS idx_whop_members_user_id ON whop_members(user_id);
        CREATE INDEX IF NOT EXISTS idx_whop_members_joined_at ON whop_members(joined_at);
      `);
      
      // Create trigger for updating timestamps
      await client.query(`
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
          
        DROP TRIGGER IF EXISTS update_whop_companies_last_activity ON whop_companies;
        CREATE TRIGGER update_whop_companies_last_activity
          BEFORE UPDATE ON whop_companies
          FOR EACH ROW
          EXECUTE FUNCTION update_updated_at_column();
      `);
      
      console.log('✅ Database tables created successfully');
      
      // Show current stats
      const stats = await client.query(`
        SELECT 
          (SELECT COUNT(*) FROM whop_companies) as total_companies,
          (SELECT COUNT(*) FROM whop_members) as total_members
      `);
      
      console.log(`📊 Current stats: ${stats.rows[0].total_companies} companies, ${stats.rows[0].total_members} members`);
      
    } catch (createError) {
      console.error('❌ Error setting up database:', createError);
    }
    
    client.release();
  })
  .catch(err => {
    console.error('❌ Database connection error:', err);
    process.exit(1);
  });

// ==================== COMPANY ID EXTRACTION ====================

function extractCompanyId(req) {
  // Enhanced company ID extraction for Whop apps
  const sources = [
    // Whop-specific headers
    req.headers['x-whop-company-id'],
    req.headers['x-company-id'], 
    req.headers['x-business-id'],
    
    // URL parameters
    req.query.company,
    req.query.company_id,
    req.query.business_id,
    
    // Body data (for webhooks)
    req.body?.company_id,
    req.body?.business_id,
    req.body?.product?.company_id,
    req.body?.data?.company_id,
    req.body?.data?.business_id,
    req.body?.data?.product?.company_id,
    
    // Extract from referer URL (when embedded in Whop)
    extractCompanyFromReferer(req.headers.referer)
  ];
  
  for (const source of sources) {
    if (source && typeof source === 'string' && source.trim()) {
      const cleanId = source.trim();
      console.log(`🏢 Found company ID: ${cleanId}`);
      return cleanId;
    }
  }
  
  return null;
}

function extractCompanyFromReferer(referer) {
  if (!referer) return null;
  
  // Extract company ID from Whop URLs
  // Examples: 
  // https://whop.com/company/biz_12345/...
  // https://biz_12345.whop.com/...
  const patterns = [
    /\/company\/([^\/\?]+)/,
    /\/business\/([^\/\?]+)/,
    /^https?:\/\/([^\.]+)\.whop\.com/,
    /company_id=([^&\?]+)/,
    /business_id=([^&\?]+)/
  ];
  
  for (const pattern of patterns) {
    const match = referer.match(pattern);
    if (match && match[1]) {
      console.log(`🔍 Extracted company ID from referer: ${match[1]}`);
      return match[1];
    }
  }
  
  return null;
}

// ==================== API ROUTES ====================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Auto-detecting Whop Directory is healthy!', 
    timestamp: new Date().toISOString(),
    version: '3.0.0',
    features: ['auto-whop-detection', 'seamless-installation']
  });
});

// Test endpoint
app.get('/api/test', (req, res) => {
  const companyId = extractCompanyId(req);
  res.json({ 
    success: true, 
    detected_company: companyId || 'none',
    headers: {
      'x-whop-company-id': req.headers['x-whop-company-id'] || 'missing',
      'x-company-id': req.headers['x-company-id'] || 'missing',
      'referer': req.headers.referer || 'missing'
    },
    timestamp: new Date().toISOString()
  });
});

// Auto-detecting members endpoint
app.get('/api/members/:companyId?', async (req, res) => {
  let { companyId } = req.params;
  
  // Extract company ID from request
  if (!companyId || companyId === 'auto') {
    companyId = extractCompanyId(req);
  }
  
  if (!companyId) {
    return res.status(400).json({
      success: false,
      error: 'Unable to detect company ID',
      help: 'Make sure this app is properly embedded in your Whop community',
      debug: {
        headers: {
          'x-whop-company-id': req.headers['x-whop-company-id'],
          'x-company-id': req.headers['x-company-id'],
          'referer': req.headers.referer
        },
        params: req.params,
        query: req.query
      }
    });
  }
  
  try {
    // Ensure company exists in database
    await ensureCompanyExists(companyId);
    
    // Get members for this company
    const result = await pool.query(`
      SELECT 
        m.id, m.user_id, m.membership_id, m.email, m.name, m.username, 
        m.custom_fields, m.joined_at, m.status, m.updated_at,
        c.company_name
      FROM whop_members m
      JOIN whop_companies c ON m.company_id = c.company_id
      WHERE m.company_id = $1
      ORDER BY m.joined_at DESC
    `, [companyId]);

    const members = result.rows.map(member => ({
      id: member.id,
      user_id: member.user_id,
      membership_id: member.membership_id,
      email: member.email,
      name: member.name,
      username: member.username,
      waitlist_responses: member.custom_fields || {},
      custom_fields: member.custom_fields || {},
      joined_at: member.joined_at,
      status: member.status,
      updated_at: member.updated_at
    }));

    res.json({
      success: true,
      members: members,
      count: members.length,
      company_id: companyId,
      company_name: result.rows[0]?.company_name || companyId,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error fetching members:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      company_id: companyId
    });
  }
});

// Helper function to ensure company exists
async function ensureCompanyExists(companyId) {
  try {
    await pool.query(`
      INSERT INTO whop_companies (company_id, company_name) 
      VALUES ($1, $1)
      ON CONFLICT (company_id) 
      DO UPDATE SET last_activity = CURRENT_TIMESTAMP
    `, [companyId]);
  } catch (error) {
    console.error('⚠️ Error ensuring company exists:', error);
  }
}

// ==================== WEBHOOK HANDLERS ====================

// Main webhook endpoint for all Whop events
app.post('/webhook/whop', async (req, res) => {
  try {
    console.log('🎯 Webhook received');
    console.log('📦 Headers:', req.headers);
    console.log('📦 Body:', JSON.stringify(req.body, null, 2));
    
    const { event_type, data } = req.body;
    
    if (!event_type || !data) {
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }

    // Extract company ID from webhook
    const companyId = extractCompanyId(req);
    
    if (!companyId) {
      console.error('❌ No company ID found in webhook');
      return res.status(400).json({ 
        error: 'No company ID found in webhook payload',
        received_data: Object.keys(data)
      });
    }

    console.log(`📨 Processing ${event_type} for company ${companyId}`);

    // Handle different webhook events
    switch (event_type) {
      case 'app_installed':
      case 'app.installed':
        await handleAppInstallation(companyId, data);
        break;
        
      case 'membership_went_valid':
      case 'membership.went_valid':
      case 'membership_created':
      case 'membership.created':
        await handleMembershipValid(companyId, data);
        break;
        
      case 'membership_went_invalid':
      case 'membership.went_invalid':
      case 'membership_cancelled':
      case 'membership.cancelled':
        await handleMembershipInvalid(companyId, data);
        break;
        
      default:
        console.log(`ℹ️ Unhandled event type: ${event_type}`);
    }

    res.json({ 
      success: true, 
      event_type,
      company_id: companyId,
      message: 'Webhook processed successfully'
    });

  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Handle app installation
async function handleAppInstallation(companyId, data) {
  console.log(`🎉 App installed for company: ${companyId}`);
  
  try {
    await pool.query(`
      INSERT INTO whop_companies (company_id, company_name, installed_at) 
      VALUES ($1, $2, CURRENT_TIMESTAMP)
      ON CONFLICT (company_id) 
      DO UPDATE SET 
        company_name = EXCLUDED.company_name,
        last_activity = CURRENT_TIMESTAMP,
        status = 'active'
    `, [companyId, data.company_name || companyId]);
    
    console.log(`✅ Company ${companyId} registered successfully`);
  } catch (error) {
    console.error('❌ Error registering company:', error);
  }
}

// Handle valid membership
async function handleMembershipValid(companyId, data) {
  const userId = data.user_id || data.user;
  const membershipId = data.id || data.membership_id;
  
  if (!userId) {
    console.error('❌ No user_id in membership webhook');
    return;
  }

  console.log(`👤 Adding member ${userId} to company ${companyId}`);
  
  // Ensure company exists
  await ensureCompanyExists(companyId);
  
  // Parse join date
  let joinedAt = new Date();
  if (data.created_at) {
    const timestamp = parseInt(data.created_at);
    if (timestamp > 946684800000) {
      joinedAt = new Date(timestamp);
    } else if (timestamp > 946684800) {
      joinedAt = new Date(timestamp * 1000);
    } else {
      joinedAt = new Date(data.created_at);
    }
  }

  try {
    await pool.query(`
      INSERT INTO whop_members (
        user_id, membership_id, company_id, email, name, username, 
        custom_fields, joined_at, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
      ON CONFLICT (user_id, company_id) 
      DO UPDATE SET 
        membership_id = EXCLUDED.membership_id,
        email = EXCLUDED.email,
        name = EXCLUDED.name,
        username = EXCLUDED.username,
        custom_fields = EXCLUDED.custom_fields,
        status = 'active',
        updated_at = CURRENT_TIMESTAMP
    `, [
      userId,
      membershipId,
      companyId,
      data.email || null,
      data.name || null,
      data.username || null,
      JSON.stringify(data.custom_field_responses || data.waitlist_responses || {}),
      joinedAt
    ]);
    
    console.log(`✅ Member ${userId} added to ${companyId}`);
  } catch (error) {
    console.error('❌ Error adding member:', error);
  }
}

// Handle invalid membership
async function handleMembershipInvalid(companyId, data) {
  const userId = data.user_id || data.user;
  
  if (!userId) {
    console.error('❌ No user_id in membership cancellation webhook');
    return;
  }

  console.log(`👤 Removing member ${userId} from company ${companyId}`);
  
  try {
    await pool.query(`
      UPDATE whop_members 
      SET status = 'inactive', updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $1 AND company_id = $2
    `, [userId, companyId]);
    
    console.log(`✅ Member ${userId} set to inactive in ${companyId}`);
  } catch (error) {
    console.error('❌ Error updating member status:', error);
  }
}

// ==================== FRONTEND ROUTES ====================

// Main app route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.get('/directory', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'directory.html'));
});

// 404 handler for API routes
app.use('/api/*', (req, res) => {
  res.status(404).json({ 
    error: 'API endpoint not found',
    available_endpoints: [
      'GET /api/health',
      'GET /api/test',
      'GET /api/members/auto',
      'POST /webhook/whop'
    ]
  });
});

// Catch-all for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== START SERVER ====================

app.listen(port, () => {
  console.log('');
  console.log('🎉 ===== AUTO-DETECTING WHOP DIRECTORY STARTED =====');
  console.log(`🚀 Server running on port ${port}`);
  console.log(`📱 App URL: ${process.env.NODE_ENV === 'production' ? 'https://whopboardy-production.up.railway.app' : `http://localhost:${port}`}/`);
  console.log(`🔗 Webhook URL: ${process.env.NODE_ENV === 'production' ? 'https://whopboardy-production.up.railway.app' : `http://localhost:${port}`}/webhook/whop`);
  console.log('');
  console.log('🔧 Features:');
  console.log('   ✅ Auto-detects company from Whop context');
  console.log('   ✅ Seamless installation flow');
  console.log('   ✅ No manual company selection needed');
  console.log('   ✅ Automatic member management');
  console.log('   ✅ Ready for Whop App Store');
  console.log('');
});

module.exports = app;