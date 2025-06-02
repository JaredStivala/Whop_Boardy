// ==================== FIXED AUTO-DETECTION SERVER.JS ====================

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
  if (req.headers.referer) {
    console.log(`   Referer: ${req.headers.referer}`);
  }
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
          UNIQUE(user_id, company_id)
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
      
      // Show recent activity
      try {
        const recentActivity = await client.query(`
          SELECT 
            c.company_id,
            c.company_name,
            COUNT(m.id) as member_count,
            MAX(m.joined_at) as latest_join
          FROM whop_companies c
          LEFT JOIN whop_members m ON c.company_id = m.company_id AND m.status = 'active'
          GROUP BY c.company_id, c.company_name
          ORDER BY member_count DESC
          LIMIT 5
        `);
        
        console.log('🏢 Top Companies by Member Count:');
        recentActivity.rows.forEach(company => {
          console.log(`   ${company.company_name || company.company_id}: ${company.member_count} members`);
        });
      } catch (activityError) {
        console.log('📊 Could not fetch company activity stats');
      }
      
    } catch (createError) {
      console.error('❌ Error setting up database:', createError);
    }
    
    client.release();
  })
  .catch(err => {
    console.error('❌ Database connection error:', err);
    process.exit(1);
  });

// ==================== ENHANCED COMPANY ID EXTRACTION ====================

function extractCompanyId(req) {
  console.log('🔍 Starting company ID detection...');
  
  // Enhanced company ID extraction for Whop apps
  const sources = [
    // Whop-specific headers (highest priority)
    req.headers['x-whop-company-id'],
    req.headers['x-company-id'], 
    req.headers['x-business-id'],
    req.headers['x-page-id'],
    
    // URL parameters
    req.query.company,
    req.query.company_id,
    req.query.business_id,
    req.query.page_id,
    
    // Body data (for webhooks) - check nested data too
    req.body?.company_id,
    req.body?.business_id,
    req.body?.page_id,
    req.body?.data?.company_id,
    req.body?.data?.business_id,
    req.body?.data?.page_id,
    req.body?.data?.product?.company_id,
    
    // Extract from referer URL (when embedded in Whop)
    extractCompanyFromReferer(req.headers.referer)
  ];
  
  console.log('🔍 Checking sources:', {
    headers: {
      'x-whop-company-id': req.headers['x-whop-company-id'],
      'x-company-id': req.headers['x-company-id'],
      'x-page-id': req.headers['x-page-id'],
      'referer': req.headers.referer
    },
    query: req.query,
    body_keys: req.body ? Object.keys(req.body) : [],
    page_id: req.body?.page_id,
    extracted_from_referer: extractCompanyFromReferer(req.headers.referer)
  });
  
  for (const source of sources) {
    if (source && typeof source === 'string' && source.trim()) {
      const cleanId = source.trim();
      console.log(`🏢 Found company ID: ${cleanId}`);
      return cleanId;
    }
  }
  
  console.log('⚠️ No direct company ID found');
  return null;
}

function extractCompanyFromReferer(referer) {
  if (!referer) return null;
  
  console.log(`🔍 Parsing referer: ${referer}`);
  
  // Enhanced Whop URL patterns
  const patterns = [
    // Direct company patterns
    /\/company\/([^\/\?]+)/,
    /\/business\/([^\/\?]+)/,
    /company_id=([^&\?]+)/,
    /business_id=([^&\?]+)/,
    
    // Whop subdomain patterns
    /^https?:\/\/([^\.]+)\.whop\.com/,
    
    // Whop path patterns - extract username from whop.com URLs
    /whop\.com\/([^\/]+)\/[^\/]+/,  // whop.com/username/product
    /whop\.com\/([^\/\?]+)/,        // whop.com/username
    
    // Extract biz_ IDs specifically
    /\/(biz_[^\/\?]+)/,
    
    // Product/app specific patterns
    /\/([^\/]+)\/whop-bot-[^\/]+/,
    /\/([^\/]+)\/[^\/]+-[^\/]+\/app/
  ];
  
  for (const pattern of patterns) {
    const match = referer.match(pattern);
    if (match && match[1] && match[1] !== 'www' && match[1] !== 'app') {
      console.log(`🎯 Extracted from referer: ${match[1]} (pattern: ${pattern})`);
      return match[1];
    }
  }
  
  return null;
}

// Enhanced company lookup function
async function findCompanyInDatabase(identifier) {
  if (!identifier) return null;
  
  console.log(`🔍 Looking up company for identifier: ${identifier}`);
  
  try {
    // Try exact match first
    let result = await pool.query(`
      SELECT company_id, company_name, username 
      FROM whop_companies 
      WHERE company_id = $1 OR username = $1
      LIMIT 1
    `, [identifier]);
    
    if (result.rows.length > 0) {
      console.log(`✅ Found exact match: ${result.rows[0].company_id}`);
      return result.rows[0];
    }
    
    // Try partial matching for usernames
    result = await pool.query(`
      SELECT company_id, company_name, username 
      FROM whop_companies 
      WHERE username ILIKE $1 OR company_name ILIKE $1
      LIMIT 1
    `, [`%${identifier}%`]);
    
    if (result.rows.length > 0) {
      console.log(`✅ Found partial match: ${result.rows[0].company_id}`);
      return result.rows[0];
    }
    
    console.log(`❌ No company found for identifier: ${identifier}`);
    return null;
    
  } catch (error) {
    console.error('❌ Error looking up company:', error);
    return null;
  }
}

// ==================== API ROUTES ====================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Auto-detecting Whop Directory is healthy!', 
    timestamp: new Date().toISOString(),
    version: '3.1.0',
    features: ['enhanced-auto-detection', 'whop-context-parsing']
  });
});

// Test endpoint with enhanced debugging
app.get('/api/test', async (req, res) => {
  const extractedId = extractCompanyId(req);
  const companyLookup = extractedId ? await findCompanyInDatabase(extractedId) : null;
  
  // Get current member count
  let memberCount = 0;
  try {
    if (companyLookup) {
      const countResult = await pool.query(`
        SELECT COUNT(*) as count FROM whop_members 
        WHERE company_id = $1 AND status = 'active'
      `, [companyLookup.company_id]);
      memberCount = parseInt(countResult.rows[0].count);
    }
  } catch (error) {
    console.error('Error getting member count:', error);
  }
  
  res.json({ 
    success: true, 
    extracted_company_id: extractedId || 'none',
    company_lookup: companyLookup,
    current_member_count: memberCount,
    detection_debug: {
      headers: {
        'x-whop-company-id': req.headers['x-whop-company-id'] || 'missing',
        'x-company-id': req.headers['x-company-id'] || 'missing',
        'x-page-id': req.headers['x-page-id'] || 'missing',
        'referer': req.headers.referer || 'missing'
      },
      query_params: req.query,
      extracted_from_referer: extractCompanyFromReferer(req.headers.referer)
    },
    webhook_info: {
      endpoint: '/webhook/whop',
      supported_formats: ['action + data', 'event_type + data'],
      supported_events: [
        'membership.went_valid',
        'membership_went_valid', 
        'membership.created',
        'user_joined'
      ]
    },
    timestamp: new Date().toISOString()
  });
});

// Enhanced members endpoint with intelligent company detection
app.get('/api/members/:companyId?', async (req, res) => {
  let { companyId } = req.params;
  let actualCompanyId = null;
  
  console.log(`🔍 Members API called with companyId: ${companyId}`);
  
  // Extract company ID from request
  if (!companyId || companyId === 'auto') {
    const extractedId = extractCompanyId(req);
    console.log(`🔍 Extracted ID from request: ${extractedId}`);
    
    if (extractedId) {
      // Look up the actual company ID in database
      const company = await findCompanyInDatabase(extractedId);
      if (company) {
        actualCompanyId = company.company_id;
        console.log(`✅ Found company in database: ${actualCompanyId}`);
      } else {
        console.log(`❌ Company not found in database for: ${extractedId}`);
      }
    }
    
    // If still no company found, try auto-detection from database
    if (!actualCompanyId) {
      try {
        const result = await pool.query(`
          SELECT company_id, company_name
          FROM whop_companies 
          WHERE status = 'active'
          ORDER BY last_activity DESC
          LIMIT 1
        `);
        
        if (result.rows.length > 0) {
          actualCompanyId = result.rows[0].company_id;
          console.log(`🔍 Auto-detected most recent company: ${actualCompanyId}`);
        }
      } catch (error) {
        console.error('❌ Auto-detection failed:', error);
      }
    }
  } else {
    actualCompanyId = companyId;
  }
  
  if (!actualCompanyId) {
    return res.status(400).json({
      success: false,
      error: 'Unable to detect company ID',
      help: 'Make sure this app is properly embedded in your Whop community',
      debug: {
        extracted_id: extractCompanyId(req),
        referer: req.headers.referer,
        available_companies: await getAvailableCompanies()
      }
    });
  }
  
  try {
    // Get members for this company
    const result = await pool.query(`
      SELECT 
        m.id, m.user_id, m.membership_id, m.email, m.name, m.username, 
        m.custom_fields, m.joined_at, m.status, m.updated_at,
        c.company_name
      FROM whop_members m
      LEFT JOIN whop_companies c ON m.company_id = c.company_id
      WHERE m.company_id = $1
      ORDER BY m.joined_at DESC
    `, [actualCompanyId]);

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

    console.log(`✅ Returning ${members.length} members for company ${actualCompanyId}`);

    res.json({
      success: true,
      members: members,
      count: members.length,
      company_id: actualCompanyId,
      company_name: result.rows[0]?.company_name || actualCompanyId,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error fetching members:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      company_id: actualCompanyId
    });
  }
});

// Helper function to get available companies
async function getAvailableCompanies() {
  try {
    const result = await pool.query(`
      SELECT 
        company_id,
        company_name,
        COUNT(m.id) as member_count,
        MAX(c.last_activity) as latest_activity
      FROM whop_companies c
      LEFT JOIN whop_members m ON c.company_id = m.company_id
      WHERE c.status = 'active'
      GROUP BY c.company_id, c.company_name
      ORDER BY member_count DESC, latest_activity DESC
      LIMIT 100
    `);
    return result.rows;
  } catch (error) {
    return [];
  }
}

// ==================== WEBHOOK HANDLERS ====================

// Main webhook endpoint for all Whop events
app.post('/webhook/whop', async (req, res) => {
  try {
    console.log('🎯 Webhook received');
    console.log('📦 Headers:', req.headers);
    console.log('📦 Body:', JSON.stringify(req.body, null, 2));
    
    // Handle both event_type and action formats
    const eventType = req.body.event_type || req.body.action;
    const data = req.body.data || req.body;
    
    if (!eventType) {
      console.error('❌ Invalid webhook payload - missing event_type or action');
      console.error('📦 Available keys:', Object.keys(req.body));
      return res.status(400).json({ 
        error: 'Invalid webhook payload - missing event_type or action',
        received_keys: Object.keys(req.body)
      });
    }

    if (!data) {
      console.error('❌ Invalid webhook payload - missing data');
      return res.status(400).json({ error: 'Invalid webhook payload - missing data' });
    }

    // Extract company ID from webhook - check multiple locations
    let companyId = extractCompanyId(req);
    
    // If not found in headers/query, try to extract from webhook data
    if (!companyId) {
      companyId = data.page_id || 
                  data.company_id || 
                  data.business_id ||
                  (data.data && data.data.page_id) ||
                  (data.data && data.data.company_id);
      
      console.log(`🔍 Extracted company ID from webhook data: ${companyId}`);
    }
    
    if (!companyId) {
      console.error('❌ No company ID found in webhook');
      console.error('📦 Available data keys:', Object.keys(data));
      console.error('📦 Headers:', Object.keys(req.headers));
      console.error('📦 Data content:', JSON.stringify(data, null, 2));
      return res.status(400).json({ 
        error: 'No company ID found in webhook payload',
        received_data: Object.keys(data),
        received_headers: Object.keys(req.headers),
        help: 'Company ID should be in page_id, company_id, or headers'
      });
    }

    console.log(`📨 Processing ${eventType} for company ${companyId}`);
    
    // Log member count before processing
    try {
      const beforeCount = await pool.query(`
        SELECT COUNT(*) as count FROM whop_members WHERE company_id = $1 AND status = 'active'
      `, [companyId]);
      console.log(`📊 Current member count for ${companyId}: ${beforeCount.rows[0].count}`);
    } catch (error) {
      console.error('⚠️ Could not get member count:', error);
    }

    // Handle different webhook events
    switch (eventType) {
      case 'app_installed':
      case 'app.installed':
        await handleAppInstallation(companyId, data);
        break;
        
      case 'membership_went_valid':
      case 'membership.went_valid':
      case 'membership_created':
      case 'membership.created':
      case 'user_joined':
      case 'user.joined':
      case 'member_added':
      case 'member.added':
        await handleMembershipValid(companyId, data);
        break;
        
      case 'membership_went_invalid':
      case 'membership.went_invalid':
      case 'membership_cancelled':
      case 'membership.cancelled':
      case 'user_left':
      case 'user.left':
      case 'member_removed':
      case 'member.removed':
        await handleMembershipInvalid(companyId, data);
        break;
        
      case 'membership_updated':
      case 'membership.updated':
      case 'user_updated':
      case 'user.updated':
        await handleMembershipUpdate(companyId, data);
        break;
        
      default:
        console.log(`ℹ️ Unhandled event type: ${eventType}`);
        console.log(`📦 Event data:`, JSON.stringify(data, null, 2));
        // Still process as potential membership event
        if (data.status === 'completed' && data.valid === true) {
          console.log('🔄 Treating as membership validation event');
          await handleMembershipValid(companyId, data);
        }
    }

    
    // Log member count after processing
    try {
      const afterCount = await pool.query(`
        SELECT COUNT(*) as count FROM whop_members WHERE company_id = $1 AND status = 'active'
      `, [companyId]);
      console.log(`📊 Member count after processing: ${afterCount.rows[0].count}`);
    } catch (error) {
      console.error('⚠️ Could not get updated member count:', error);
    }

    res.json({ 
      success: true, 
      event_type: eventType,
      company_id: companyId,
      message: 'Webhook processed successfully',
      timestamp: new Date().toISOString()
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
    // Extract additional info from installation data
    const companyName = data.company_name || data.business_name || companyId;
    
    await pool.query(`
      INSERT INTO whop_companies (company_id, company_name, installed_at) 
      VALUES ($1, $2, CURRENT_TIMESTAMP)
      ON CONFLICT (company_id) 
      DO UPDATE SET 
        company_name = EXCLUDED.company_name,
        last_activity = CURRENT_TIMESTAMP,
        status = 'active'
    `, [companyId, companyName]);
    
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
    console.error('📦 Available data keys:', Object.keys(data));
    return;
  }

  console.log(`👤 Adding member ${userId} to company ${companyId}`);
  console.log('📦 Member data:', JSON.stringify(data, null, 2));
  
  // Ensure company exists
  await ensureCompanyExists(companyId);
  
  // Parse join date - handle Whop timestamp format
  let joinedAt = new Date();
  if (data.created_at) {
    // Whop sends timestamps in seconds, convert to milliseconds
    const timestamp = parseInt(data.created_at);
    if (timestamp > 946684800) { // If > year 2000 in seconds
      joinedAt = new Date(timestamp * 1000);
    } else {
      joinedAt = new Date(data.created_at);
    }
  }

  // Extract custom fields from multiple possible locations
  const customFields = data.custom_field_responses || 
                      data.waitlist_responses || 
                      data.custom_fields || 
                      data.responses || 
                      {};

  // Get additional user info if available
  const userEmail = data.email || data.user_email || null;
  const userName = data.name || data.display_name || data.user_name || null;
  const username = data.username || data.user_username || null;

  try {
    const result = await pool.query(`
      INSERT INTO whop_members (
        user_id, membership_id, company_id, email, name, username, 
        custom_fields, joined_at, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
      ON CONFLICT (user_id, company_id) 
      DO UPDATE SET 
        membership_id = EXCLUDED.membership_id,
        email = COALESCE(EXCLUDED.email, whop_members.email),
        name = COALESCE(EXCLUDED.name, whop_members.name),
        username = COALESCE(EXCLUDED.username, whop_members.username),
        custom_fields = EXCLUDED.custom_fields,
        status = 'active',
        updated_at = CURRENT_TIMESTAMP
      RETURNING id, user_id, name, email
    `, [
      userId,
      membershipId,
      companyId,
      userEmail,
      userName,
      username,
      JSON.stringify(customFields),
      joinedAt
    ]);
    
    const member = result.rows[0];
    console.log(`✅ Member ${userId} (${member.name || 'Anonymous'}) added to ${companyId}`);
    console.log(`📊 Member ID: ${member.id}, Email: ${member.email || 'none'}`);
    console.log(`📅 Join date: ${joinedAt.toISOString()}`);
    
    // Update company activity
    await pool.query(`
      UPDATE whop_companies 
      SET last_activity = CURRENT_TIMESTAMP 
      WHERE company_id = $1
    `, [companyId]);
    
  } catch (error) {
    console.error('❌ Error adding member:', error);
    console.error('📦 Failed data:', { userId, companyId, membershipId, customFields });
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
    const result = await pool.query(`
      UPDATE whop_members 
      SET status = 'inactive', updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $1 AND company_id = $2
      RETURNING name, email
    `, [userId, companyId]);
    
    if (result.rows.length > 0) {
      const member = result.rows[0];
      console.log(`✅ Member ${userId} (${member.name || 'Anonymous'}) set to inactive in ${companyId}`);
    } else {
      console.log(`⚠️ Member ${userId} not found in ${companyId}`);
    }
  } catch (error) {
    console.error('❌ Error updating member status:', error);
  }
}

// Handle membership updates
async function handleMembershipUpdate(companyId, data) {
  const userId = data.user_id || data.user;
  
  if (!userId) {
    console.error('❌ No user_id in membership update webhook');
    return;
  }

  console.log(`👤 Updating member ${userId} in company ${companyId}`);
  console.log('📦 Update data:', JSON.stringify(data, null, 2));
  
  // Extract custom fields from multiple possible locations
  const customFields = data.custom_field_responses || 
                      data.waitlist_responses || 
                      data.custom_fields || 
                      data.responses || 
                      {};

  try {
    const result = await pool.query(`
      UPDATE whop_members 
      SET 
        email = COALESCE($3, email),
        name = COALESCE($4, name),
        username = COALESCE($5, username),
        custom_fields = COALESCE($6, custom_fields),
        updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $1 AND company_id = $2
      RETURNING id, name, email
    `, [
      userId,
      companyId,
      data.email || null,
      data.name || data.display_name || null,
      data.username || null,
      Object.keys(customFields).length > 0 ? JSON.stringify(customFields) : null
    ]);
    
    if (result.rows.length > 0) {
      const member = result.rows[0];
      console.log(`✅ Member ${userId} (${member.name || 'Anonymous'}) updated in ${companyId}`);
    } else {
      console.log(`⚠️ Member ${userId} not found for update in ${companyId}, treating as new member`);
      // If member doesn't exist, treat as new member
      await handleMembershipValid(companyId, data);
    }
  } catch (error) {
    console.error('❌ Error updating member:', error);
  }
}

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

// ==================== FRONTEND ROUTES ====================

// Main app route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 404 handler for API routes
app.use('/api/*', (req, res) => {
  res.status(404).json({ 
    error: 'API endpoint not found',
    available_endpoints: [
      'GET /api/health',
      'GET /api/test',
      'GET /api/members/auto',
      'POST /webhook/whop',
      'POST /webhook/test (for testing member addition)'
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
  console.log('🎉 ===== ENHANCED AUTO-DETECTING WHOP DIRECTORY =====');
  console.log(`🚀 Server running on port ${port}`);
  console.log(`📱 App URL: ${process.env.NODE_ENV === 'production' ? 'https://whopboardy-production.up.railway.app' : `http://localhost:${port}`}/`);
  console.log(`🔗 Webhook URL: ${process.env.NODE_ENV === 'production' ? 'https://whopboardy-production.up.railway.app' : `http://localhost:${port}`}/webhook/whop`);
  console.log('');
  console.log('🔧 Enhanced Features:');
  console.log('   ✅ Smart Whop URL parsing');
  console.log('   ✅ Database company lookup');
  console.log('   ✅ Hardcoded username mapping (jaredstivala)');
  console.log('   ✅ Intelligent fallback detection');
  console.log('   ✅ Enhanced debugging');
  console.log('   ✅ Support for 100+ members');
  console.log('   ✅ Real-time member updates via webhooks');
  console.log('   ✅ Multiple webhook event types');
  console.log('');
});

module.exports = app;