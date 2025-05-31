// server.js - Whop App Implementation
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Whop API helper functions using app authentication
async function fetchWhopUserData(userId, installationToken) {
  try {
    const response = await fetch(`https://api.whop.com/api/v2/users/${userId}`, {
      headers: {
        'Authorization': `Bearer ${installationToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      console.log(`User API error: ${response.status}`);
      return null;
    }
    
    return await response.json();
  } catch (error) {
    console.error('Error fetching user data:', error);
    return null;
  }
}

async function fetchWhopMembershipData(membershipId, installationToken) {
  try {
    const response = await fetch(`https://api.whop.com/api/v2/memberships/${membershipId}`, {
      headers: {
        'Authorization': `Bearer ${installationToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      console.log(`Membership API error: ${response.status}`);
      return null;
    }
    
    return await response.json();
  } catch (error) {
    console.error('Error fetching membership data:', error);
    return null;
  }
}

// Initialize database tables for app
async function initializeDatabase() {
  const client = await pool.connect();
  try {
    // App installations table
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_installations (
        id SERIAL PRIMARY KEY,
        whop_company_id VARCHAR(255) UNIQUE NOT NULL,
        company_name VARCHAR(255),
        installation_id VARCHAR(255) UNIQUE NOT NULL,
        access_token TEXT,
        installed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_active BOOLEAN DEFAULT TRUE
      )
    `);

    // Members table for the app
    await client.query(`
      CREATE TABLE IF NOT EXISTS members (
        id SERIAL PRIMARY KEY,
        whop_company_id VARCHAR(255) NOT NULL,
        whop_user_id VARCHAR(255) NOT NULL,
        whop_membership_id VARCHAR(255) UNIQUE NOT NULL,
        email VARCHAR(255),
        username VARCHAR(255),
        name VARCHAR(255),
        profile_picture_url TEXT,
        waitlist_responses JSONB DEFAULT '{}',
        membership_data JSONB DEFAULT '{}',
        status VARCHAR(50) DEFAULT 'active',
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(whop_company_id, whop_user_id)
      )
    `);

    // Create indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_members_company_id ON members(whop_company_id)
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_installations_company_id ON app_installations(whop_company_id)
    `);

    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
  } finally {
    client.release();
  }
}

// Webhook verification endpoint (for app installation)
app.get('/webhook/whop', (req, res) => {
  console.log('🔍 Webhook verification request received');
  res.status(200).json({ 
    status: 'ok', 
    message: 'Webhook endpoint is active',
    timestamp: new Date().toISOString()
  });
});

// Enhanced webhook handler for Whop App
app.post('/webhook/whop', async (req, res) => {
  try {
    console.log('🔔 App webhook received:', JSON.stringify(req.body, null, 2));
    console.log('🔍 Headers:', JSON.stringify(req.headers, null, 2));
    
    const webhookData = req.body;
    const eventType = webhookData.action || webhookData.type;
    const eventData = webhookData.data;

    console.log(`🎯 Processing app event: ${eventType}`);

    // Handle different app events
    switch (eventType) {
      case 'app_membership.went_valid':
      case 'membership.went_valid':
        await handleAppMembershipValid(eventData, webhookData);
        break;
        
      case 'app_membership.went_invalid':
      case 'membership.went_invalid':
        await handleAppMembershipInvalid(eventData, webhookData);
        break;
        
      case 'app.installed':
      case 'app_installed':
        await handleAppInstalled(eventData);
        break;
        
      case 'app.uninstalled':
      case 'app_uninstalled':
        await handleAppUninstalled(eventData);
        break;
        
      default:
        console.log(`ℹ️ Ignoring event type: ${eventType}`);
        console.log('📋 Available data keys:', Object.keys(eventData || {}));
    }

    res.status(200).json({ 
      success: true, 
      message: 'App webhook processed successfully',
      eventType 
    });

  } catch (error) {
    console.error('💥 App webhook processing error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// Handle app membership becoming valid
async function handleAppMembershipValid(eventData, webhookData) {
  try {
    const userId = eventData.user_id || eventData.user?.id;
    const membershipId = eventData.id;
    const companyId = eventData.company_id || webhookData.company_id;

    if (!userId || !membershipId || !companyId) {
      console.error('❌ Missing required fields:', { userId, membershipId, companyId });
      return;
    }

    console.log(`📝 Processing app member: ${userId} for company: ${companyId}`);

    // Auto-register installation if it doesn't exist
    await ensureInstallationExists(companyId, webhookData);

    // Get installation info for this company
    const installationResult = await pool.query(
      'SELECT access_token, company_name FROM app_installations WHERE whop_company_id = $1 AND is_active = TRUE',
      [companyId]
    );

    if (installationResult.rows.length === 0) {
      console.log(`⚠️ No active installation found for company: ${companyId}`);
      // Still store the member, but without API data
      await storeMemberBasic(eventData, companyId);
      return;
    }

    const { access_token } = installationResult.rows[0];

    // Fetch detailed user data using app token
    const userData = await fetchWhopUserData(userId, access_token);
    const membershipData = await fetchWhopMembershipData(membershipId, access_token);

    // Extract custom field responses
    let waitlistResponses = {};
    if (membershipData) {
      waitlistResponses = {
        ...membershipData.custom_fields_responses,
        ...membershipData.custom_fields_responses_v2
      };
    }

    // Store member with full data
    const result = await pool.query(`
      INSERT INTO members (
        whop_company_id, 
        whop_user_id, 
        whop_membership_id,
        email, 
        username, 
        name, 
        profile_picture_url,
        waitlist_responses, 
        membership_data, 
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active')
      ON CONFLICT (whop_membership_id)
      DO UPDATE SET
        email = EXCLUDED.email,
        username = EXCLUDED.username,
        name = EXCLUDED.name,
        profile_picture_url = EXCLUDED.profile_picture_url,
        waitlist_responses = EXCLUDED.waitlist_responses,
        membership_data = EXCLUDED.membership_data,
        status = 'active',
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `, [
      companyId,
      userId,
      membershipId,
      userData?.email || null,
      userData?.username || null,
      userData?.name || userData?.display_name || null,
      userData?.profile_picture_url || null,
      JSON.stringify(waitlistResponses),
      JSON.stringify(eventData)
    ]);

    console.log(`✅ App member ${userId} stored successfully (DB ID: ${result.rows[0].id})`);
    console.log(`📋 Waitlist responses: ${Object.keys(waitlistResponses).length} fields`);

  } catch (error) {
    console.error('❌ Error handling app membership valid:', error);
  }
}

// Ensure installation exists (auto-register from webhook data)
async function ensureInstallationExists(companyId, webhookData) {
  try {
    const existingInstallation = await pool.query(
      'SELECT id FROM app_installations WHERE whop_company_id = $1',
      [companyId]
    );

    if (existingInstallation.rows.length === 0) {
      console.log(`🔧 Auto-registering installation for company: ${companyId}`);
      
      await pool.query(`
        INSERT INTO app_installations (whop_company_id, installation_id, is_active)
        VALUES ($1, $2, TRUE)
      `, [companyId, `auto_${Date.now()}`]);
      
      console.log(`✅ Auto-registered installation for company: ${companyId}`);
    }
  } catch (error) {
    console.error('❌ Error ensuring installation exists:', error);
  }
}

// Store member with basic webhook data only
async function storeMemberBasic(eventData, companyId) {
  const userId = eventData.user_id || eventData.user?.id;
  const membershipId = eventData.id;
  
  await pool.query(`
    INSERT INTO members (
      whop_company_id, 
      whop_user_id, 
      whop_membership_id,
      membership_data, 
      status
    )
    VALUES ($1, $2, $3, $4, 'active')
    ON CONFLICT (whop_membership_id)
    DO UPDATE SET
      membership_data = EXCLUDED.membership_data,
      status = 'active',
      updated_at = CURRENT_TIMESTAMP
  `, [companyId, userId, membershipId, JSON.stringify(eventData)]);
  
  console.log(`✅ Basic member data stored for ${userId}`);
}

// Handle app membership becoming invalid
async function handleAppMembershipInvalid(eventData, webhookData) {
  const userId = eventData.user_id || eventData.user?.id;
  const membershipId = eventData.id;
  const companyId = eventData.company_id || webhookData.company_id;

  await pool.query(
    'UPDATE members SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE whop_company_id = $2 AND (whop_user_id = $3 OR whop_membership_id = $4)',
    ['inactive', companyId, userId, membershipId]
  );

  console.log(`✅ Deactivated app member ${userId} for company ${companyId}`);
}

// Handle app installation
async function handleAppInstalled(eventData) {
  try {
    const { company_id, installation_id, access_token } = eventData;
    
    await pool.query(`
      INSERT INTO app_installations (whop_company_id, installation_id, access_token, is_active)
      VALUES ($1, $2, $3, TRUE)
      ON CONFLICT (whop_company_id)
      DO UPDATE SET
        installation_id = EXCLUDED.installation_id,
        access_token = EXCLUDED.access_token,
        is_active = TRUE,
        installed_at = CURRENT_TIMESTAMP
    `, [company_id, installation_id, access_token]);

    console.log(`✅ App installed for company: ${company_id}`);
  } catch (error) {
    console.error('❌ Error handling app installation:', error);
  }
}

// Handle app uninstallation
async function handleAppUninstalled(eventData) {
  try {
    const { company_id } = eventData;
    
    await pool.query(
      'UPDATE app_installations SET is_active = FALSE WHERE whop_company_id = $1',
      [company_id]
    );

    console.log(`✅ App uninstalled for company: ${company_id}`);
  } catch (error) {
    console.error('❌ Error handling app uninstallation:', error);
  }
}

// API Routes for the app

// Manual app installation registration
app.post('/api/register-installation', async (req, res) => {
  try {
    const { whop_company_id, company_name, access_token } = req.body;

    if (!whop_company_id) {
      return res.status(400).json({ error: 'whop_company_id is required' });
    }

    const result = await pool.query(`
      INSERT INTO app_installations (whop_company_id, company_name, installation_id, access_token, is_active)
      VALUES ($1, $2, $3, $4, TRUE)
      ON CONFLICT (whop_company_id)
      DO UPDATE SET
        company_name = EXCLUDED.company_name,
        access_token = EXCLUDED.access_token,
        is_active = TRUE,
        installed_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [whop_company_id, company_name || 'Manual Install', `manual_${Date.now()}`, access_token]);

    console.log(`✅ Manually registered installation for: ${whop_company_id}`);
    res.json({ success: true, installation: result.rows[0] });
  } catch (error) {
    console.error('❌ Error registering installation:', error);
    res.status(500).json({ error: 'Failed to register installation' });
  }
});

// Get member directory for a company (used by the app UI)
app.get('/api/directory/:companyId', async (req, res) => {
  try {
    const { companyId } = req.params;
    const { status = 'active' } = req.query;

    // Check if app is installed for this company
    const installationCheck = await pool.query(
      'SELECT company_name FROM app_installations WHERE whop_company_id = $1 AND is_active = TRUE',
      [companyId]
    );

    if (installationCheck.rows.length === 0) {
      return res.status(404).json({ error: 'App not installed for this company' });
    }

    const result = await pool.query(`
      SELECT 
        id,
        whop_user_id,
        whop_membership_id,
        email,
        username,
        name,
        profile_picture_url,
        waitlist_responses,
        joined_at,
        status
      FROM members 
      WHERE whop_company_id = $1 AND status = $2
      ORDER BY joined_at DESC
    `, [companyId, status]);

    res.json({
      success: true,
      company: installationCheck.rows[0].company_name,
      members: result.rows,
      count: result.rows.length
    });
  } catch (error) {
    console.error('Error fetching directory:', error);
    res.status(500).json({ error: 'Failed to fetch directory' });
  }
});

// Get app installation status
app.get('/api/installation/:companyId', async (req, res) => {
  try {
    const { companyId } = req.params;

    const result = await pool.query(
      'SELECT whop_company_id, company_name, installed_at, is_active FROM app_installations WHERE whop_company_id = $1',
      [companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'App not installed' });
    }

    res.json({ success: true, installation: result.rows[0] });
  } catch (error) {
    console.error('Error fetching installation:', error);
    res.status(500).json({ error: 'Failed to fetch installation status' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    type: 'whop_app'
  });
});

// Serve the directory page for companies
app.get('/directory.html', (req, res) => {
  res.sendFile(__dirname + '/public/directory.html');
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'Whop Member Directory App',
    status: 'running',
    webhook_url: '/webhook/whop',
    directory_url: '/directory.html?company=COMPANY_ID'
  });
});

// Initialize database and start server
initializeDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Whop App server running on port ${PORT}`);
    console.log(`📱 App webhook endpoint: ${process.env.BASE_URL || 'http://localhost:' + PORT}/webhook/whop`);
    console.log(`🌐 Directory URL: ${process.env.BASE_URL || 'http://localhost:' + PORT}/directory.html?company=COMPANY_ID`);
  });
});

module.exports = app;