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
async function fetchWhopUserData(userId, apiKey) {
  try {
    // Use V5 app endpoint for user data  
    const response = await fetch(`https://api.whop.com/api/v5/app/users/${userId}`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      console.log(`❌ User API error: ${response.status}`);
      return null;
    }
    
    const data = await response.json();
    console.log('🔍 User API response:', JSON.stringify(data, null, 2));
    return data;
  } catch (error) {
    console.error('❌ Error fetching user data:', error);
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
    // Simplified database initialization to reduce memory usage
    console.log('🔄 Initializing database...');
    
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

    // Members table - simpler approach, just recreate if needed
    const tableExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'members'
      )
    `);
    
    if (!tableExists.rows[0].exists) {
      console.log('🔧 Creating members table...');
      await client.query(`
        CREATE TABLE members (
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
    } else {
      // Check if whop_membership_id column exists
      const columnExists = await client.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'members' AND column_name = 'whop_membership_id'
      `);
      
      if (columnExists.rows.length === 0) {
        console.log('🔧 Adding missing whop_membership_id column...');
        await client.query(`
          ALTER TABLE members 
          ADD COLUMN whop_membership_id VARCHAR(255) UNIQUE
        `);
        await client.query(`
          UPDATE members 
          SET whop_membership_id = 'mem_' || id || '_' || extract(epoch from now())
          WHERE whop_membership_id IS NULL
        `);
      }
    }

    // Essential indexes only
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_members_company_id ON members(whop_company_id)
    `);

    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
    throw error; // Re-throw to handle in main function
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
    const companyId = eventData.page_id; // This is the actual company ID in the webhook!

    console.log('🔍 Basic webhook data:', { userId, membershipId, companyId });

    if (!userId || !membershipId) {
      console.error('❌ Missing user_id or membership_id');
      return;
    }

    if (!companyId) {
      console.error('❌ No company/page_id found in webhook');
      return;
    }

    console.log('✅ Found company ID from page_id:', companyId);

    // Ensure installation exists FIRST (this is critical)
    await ensureInstallationExists(companyId, eventData);

    // Extract custom field responses from webhook data
    let waitlistResponses = {};
    
    // The custom_field_responses appears to be a Ruby ActiveRecord object
    // Let's try different approaches to extract the data
    console.log('📋 Raw custom field responses:', eventData.custom_field_responses);
    console.log('📋 Type of custom field responses:', typeof eventData.custom_field_responses);
    
    // Try to extract meaningful data from the webhook payload
    // Look for any fields that might contain form responses
    const allKeys = Object.keys(eventData);
    console.log('📋 All webhook data keys:', allKeys);
    
    // Check each field for potential custom data
    allKeys.forEach(key => {
      const value = eventData[key];
      if (typeof value === 'string' && value.length > 0 && value.length < 1000) {
        // Potential custom field response
        if (key.includes('custom') || key.includes('field') || key.includes('response') || 
            key.includes('question') || key.includes('answer') || key.includes('form')) {
          waitlistResponses[key] = value;
          console.log(`📝 Found potential custom field: ${key} = ${value}`);
        }
      }
    });

    console.log('📋 Extracted waitlist responses:', waitlistResponses);

    // Store member with webhook data (with proper error handling)
    try {
      console.log('💾 Attempting to store member...');
      
      const result = await pool.query(`
        INSERT INTO members (
          whop_company_id, 
          whop_user_id, 
          whop_membership_id,
          waitlist_responses, 
          membership_data, 
          status
        )
        VALUES ($1, $2, $3, $4, $5, 'active')
        ON CONFLICT (whop_membership_id)
        DO UPDATE SET
          waitlist_responses = EXCLUDED.waitlist_responses,
          membership_data = EXCLUDED.membership_data,
          status = 'active',
          updated_at = CURRENT_TIMESTAMP
        RETURNING id
      `, [
        companyId,
        userId,
        membershipId,
        JSON.stringify(waitlistResponses),
        JSON.stringify(eventData)
      ]);

      console.log(`✅ Member ${userId} stored successfully for company ${companyId} (DB ID: ${result.rows[0].id})`);
      console.log(`📋 Waitlist responses stored: ${Object.keys(waitlistResponses).length} fields`);

      // Try to fetch user details (this might work even if membership API doesn't)
      await tryFetchUserDetails(userId, companyId, result.rows[0].id);

    } catch (dbError) {
      console.error('💥 Database error when storing member:', dbError);
      console.error('📋 Data being inserted:', {
        companyId,
        userId, 
        membershipId,
        waitlistResponses,
        eventDataKeys: Object.keys(eventData)
      });
      
      // Try a simpler insert without JSONB fields
      try {
        console.log('🔄 Trying simplified member insert...');
        const simpleResult = await pool.query(`
          INSERT INTO members (whop_company_id, whop_user_id, whop_membership_id, status)
          VALUES ($1, $2, $3, 'active')
          ON CONFLICT (whop_membership_id) DO NOTHING
          RETURNING id
        `, [companyId, userId, membershipId]);
        
        if (simpleResult.rows.length > 0) {
          console.log(`✅ Member stored with simplified data (DB ID: ${simpleResult.rows[0].id})`);
        } else {
          console.log('ℹ️ Member already exists, skipping insert');
        }
      } catch (simpleError) {
        console.error('💥 Even simplified insert failed:', simpleError);
      }
    }

  } catch (error) {
    console.error('❌ Error handling app membership valid:', error);
  }
}

// Try to fetch and update user details separately
async function tryFetchUserDetails(userId, companyId, memberId) {
  try {
    const apiKey = process.env.WHOP_API_KEY;
    if (!apiKey) return;

    console.log('🔄 Attempting to fetch user details...');
    const userData = await fetchWhopUserData(userId, apiKey);
    
    if (userData) {
      await pool.query(`
        UPDATE members 
        SET email = $1, username = $2, name = $3, profile_picture_url = $4, updated_at = CURRENT_TIMESTAMP
        WHERE id = $5
      `, [
        userData.email || null,
        userData.username || null, 
        userData.name || userData.display_name || null,
        userData.profile_picture_url || null,
        memberId
      ]);
      
      console.log('✅ User details updated successfully');
    } else {
      console.log('⚠️ Could not fetch user details, but member stored with basic data');
    }
  } catch (error) {
    console.log('⚠️ User details fetch failed, but member was stored:', error.message);
  }
}

// Ensure installation exists (auto-register from membership data)
async function ensureInstallationExists(companyId, membershipData) {
  try {
    console.log(`🔧 Checking installation for company: ${companyId}`);
    
    const existingInstallation = await pool.query(
      'SELECT id FROM app_installations WHERE whop_company_id = $1',
      [companyId]
    );

    if (existingInstallation.rows.length === 0) {
      console.log(`🔧 Auto-registering installation for company: ${companyId}`);
      
      const result = await pool.query(`
        INSERT INTO app_installations (whop_company_id, company_name, installation_id, is_active)
        VALUES ($1, $2, $3, TRUE)
        RETURNING id
      `, [companyId, `Company ${companyId}`, `auto_${Date.now()}`]);
      
      console.log(`✅ Auto-registered installation for company: ${companyId} (ID: ${result.rows[0].id})`);
    } else {
      console.log(`✅ Installation already exists for company: ${companyId}`);
    }
  } catch (error) {
    console.error('❌ Error ensuring installation exists:', error);
    
    // Try a simpler insert without the foreign key constraint issues
    try {
      console.log('🔄 Trying simplified installation insert...');
      await pool.query(`
        INSERT INTO app_installations (whop_company_id, installation_id, is_active)
        VALUES ($1, $2, TRUE)
        ON CONFLICT (whop_company_id) DO NOTHING
      `, [companyId, `auto_${Date.now()}`]);
      console.log('✅ Simplified installation insert completed');
    } catch (simpleError) {
      console.error('💥 Even simplified installation insert failed:', simpleError);
    }
  }
}

// Handle app membership becoming invalid
async function handleAppMembershipInvalid(eventData, webhookData) {
  try {
    const membershipId = eventData.id;
    const userId = eventData.user_id || eventData.user?.id;

    // Update member status by membership ID
    const result = await pool.query(
      'UPDATE members SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE whop_membership_id = $2 RETURNING whop_company_id, whop_user_id',
      ['inactive', membershipId]
    );

    if (result.rows.length > 0) {
      const { whop_company_id, whop_user_id } = result.rows[0];
      console.log(`✅ Deactivated member ${whop_user_id} for company ${whop_company_id}`);
    } else {
      console.log(`⚠️ No member found with membership ID: ${membershipId}`);
    }
  } catch (error) {
    console.error('❌ Error handling membership invalid:', error);
  }
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
    const { whop_company_id, company_name } = req.body;

    if (!whop_company_id) {
      return res.status(400).json({ error: 'whop_company_id is required' });
    }

    const result = await pool.query(`
      INSERT INTO app_installations (whop_company_id, company_name, installation_id, is_active)
      VALUES ($1, $2, $3, TRUE)
      ON CONFLICT (whop_company_id)
      DO UPDATE SET
        company_name = EXCLUDED.company_name,
        is_active = TRUE,
        installed_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [whop_company_id, company_name || 'Manual Install', `manual_${Date.now()}`]);

    console.log(`✅ Manually registered installation for: ${whop_company_id}`);
    res.json({ success: true, installation: result.rows[0] });
  } catch (error) {
    console.error('❌ Error registering installation:', error);
    res.status(500).json({ error: 'Failed to register installation' });
  }
});

// Debug endpoint to check database state
app.get('/debug/database', async (req, res) => {
  try {
    const installationsResult = await pool.query('SELECT * FROM app_installations ORDER BY installed_at DESC LIMIT 5');
    const membersResult = await pool.query('SELECT * FROM members ORDER BY joined_at DESC LIMIT 5');
    
    res.json({
      success: true,
      installations: installationsResult.rows,
      members: membersResult.rows,
      installationsCount: installationsResult.rows.length,
      membersCount: membersResult.rows.length
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'Database query failed', 
      details: error.message 
    });
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
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Whop App server running on port ${PORT}`);
    console.log(`📱 App webhook endpoint: ${process.env.BASE_URL || 'http://localhost:' + PORT}/webhook/whop`);
    console.log(`🌐 Directory URL: ${process.env.BASE_URL || 'http://localhost:' + PORT}/directory.html?company=COMPANY_ID`);
    
    // Environment variable check
    if (!process.env.WHOP_API_KEY) {
      console.warn('⚠️  WHOP_API_KEY environment variable not set! Member data fetching will fail.');
      console.warn('   Set this in your Railway dashboard Variables section.');
    } else {
      console.log('✅ WHOP_API_KEY configured');
    }
    
    // Send keep-alive signal to Railway
    if (process.env.NODE_ENV === 'production') {
      setInterval(() => {
        console.log('💓 Server heartbeat');
      }, 30000); // Every 30 seconds
    }
  });
}).catch(error => {
  console.error('💥 Failed to initialize database:', error);
  process.exit(1);
});

module.exports = app;
