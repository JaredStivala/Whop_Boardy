// ==================== WHOP APP STORE READY SERVER.JS - FINAL FIX ====================

const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

console.log('🚀 Starting Whop App Store Ready Member Directory - FINAL FIX...');

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
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-company-id, x-whop-company-id, x-business-id, x-page-id');
  
  // Allow embedding in Whop iframes
  res.header('X-Frame-Options', 'ALLOWALL');
  res.header('Content-Security-Policy', "frame-ancestors *");
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Enhanced request logging with installation detection
app.use((req, res, next) => {
  // Skip company detection for static resources and system requests
  const skipDetectionPaths = ['/favicon.ico', '/robots.txt', '/sitemap.xml', '.css', '.js', '.png', '.jpg', '.svg'];
  const shouldSkipDetection = skipDetectionPaths.some(path => req.path.includes(path));
  
  if (!shouldSkipDetection) {
    const companyId = extractCompanyId(req);
    const isAppView = req.path === '/' || req.path === '/index.html';
    
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path} [Company: ${companyId || 'auto-detect'}] ${isAppView ? '[APP_VIEW]' : ''}`);
    
    if (req.headers.referer) {
      console.log(`   Referer: ${req.headers.referer}`);
    }
    
    // Log Whop-specific headers for debugging
    if (req.headers['x-page-id'] || req.headers['x-whop-company-id']) {
      console.log(`   Whop Headers: page-id=${req.headers['x-page-id']}, company-id=${req.headers['x-whop-company-id']}`);
    }
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
      // Create companies table - BACKWARD COMPATIBLE with existing installed_at column
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
        CREATE INDEX IF NOT EXISTS idx_whop_companies_status ON whop_companies(status);
      `);
      
      // Add app store columns if they don't exist (for backward compatibility)
      try {
        await client.query(`
          ALTER TABLE whop_companies 
          ADD COLUMN IF NOT EXISTS first_viewed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
        `);
        await client.query(`
          ALTER TABLE whop_companies 
          ADD COLUMN IF NOT EXISTS installation_source VARCHAR(100) DEFAULT 'app_store';
        `);
        await client.query(`
          ALTER TABLE whop_companies 
          ADD COLUMN IF NOT EXISTS app_version VARCHAR(50) DEFAULT '3.2.1';
        `);
        console.log('✅ App store columns added for compatibility');
      } catch (error) {
        console.log('ℹ️ App store columns already exist or couldn\'t be added');
      }
      
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
        CREATE INDEX IF NOT EXISTS idx_whop_members_status ON whop_members(status);
      `);
      
      // Create installation tracking table (optional, for analytics) - NO FOREIGN KEY to avoid errors
      await client.query(`
        CREATE TABLE IF NOT EXISTS app_installations (
          id SERIAL PRIMARY KEY,
          company_id VARCHAR(255) NOT NULL,
          installed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          installation_method VARCHAR(100) DEFAULT 'first_view',
          user_agent TEXT,
          referer_url TEXT,
          installation_data JSONB DEFAULT '{}'
        );
        
        CREATE INDEX IF NOT EXISTS idx_app_installations_company_id ON app_installations(company_id);
      `);
      
      // Create triggers for updating timestamps - FIXED
      await client.query(`
        CREATE OR REPLACE FUNCTION update_updated_at_column()
        RETURNS TRIGGER AS $
        BEGIN
          IF TG_TABLE_NAME = 'whop_members' THEN
            NEW.updated_at = CURRENT_TIMESTAMP;
          END IF;
          RETURN NEW;
        END;
        $ language 'plpgsql';
        
        CREATE OR REPLACE FUNCTION update_last_activity_column()
        RETURNS TRIGGER AS $
        BEGIN
          IF TG_TABLE_NAME = 'whop_companies' THEN
            NEW.last_activity = CURRENT_TIMESTAMP;
          END IF;
          RETURN NEW;
        END;
        $ language 'plpgsql';
        
        DROP TRIGGER IF EXISTS update_whop_members_updated_at ON whop_members;
        CREATE TRIGGER update_whop_members_updated_at
          BEFORE UPDATE ON whop_members
          FOR EACH ROW
          EXECUTE FUNCTION update_updated_at_column();
          
        DROP TRIGGER IF EXISTS update_whop_companies_last_activity ON whop_companies;
        CREATE TRIGGER update_whop_companies_last_activity
          BEFORE UPDATE ON whop_companies
          FOR EACH ROW
          EXECUTE FUNCTION update_last_activity_column();
      `);
      
      console.log('✅ Database tables created successfully');
      
      // Show current stats
      const stats = await client.query(`
        SELECT 
          (SELECT COUNT(*) FROM whop_companies WHERE status = 'active') as active_directories,
          (SELECT COUNT(*) FROM whop_members WHERE status = 'active') as total_active_members
      `);
      
      console.log(`📊 Current stats: ${stats.rows[0].active_directories} active directories, ${stats.rows[0].total_active_members} members`);
      
    } catch (createError) {
      console.error('❌ Error setting up database:', createError);
    }
    
    client.release();
  })
  .catch(err => {
    console.error('❌ Database connection error:', err);
    process.exit(1);
  });

// ==================== ENHANCED COMPANY ID EXTRACTION - FIXED FOR WHOP ====================

function extractCompanyId(req) {
  console.log('🔍 Starting ENHANCED company ID detection...');
  console.log(`🔍 Full request details:`, {
    host: req.get('host'),
    originalUrl: req.originalUrl,
    referer: req.headers.referer,
    userAgent: req.get('user-agent')
  });
  
  // Enhanced company ID extraction for Whop apps with app store support
  const sources = [
    // Whop-specific headers (highest priority)
    req.headers['x-page-id'],           // Primary Whop identifier
    req.headers['x-whop-company-id'],
    req.headers['x-company-id'], 
    req.headers['x-business-id'],
    
    // URL parameters
    req.query.company,
    req.query.company_id,
    req.query.business_id,
    req.query.page_id,
    req.query.biz,
    
    // Body data (for webhooks)
    req.body?.page_id,
    req.body?.company_id,
    req.body?.business_id,
    req.body?.data?.page_id,
    req.body?.data?.company_id,
    req.body?.data?.business_id,
    req.body?.data?.product?.company_id,
    
    // CRITICAL: Extract from Whop's internal app structure (NEW!)
    extractCompanyFromWhopApps(req.headers.referer),
    
    // Extract from referer URL (fallback)
    extractCompanyFromReferer(req.headers.referer)
  ];
  
  console.log('🔍 Checking all sources for company ID:', {
    headers: {
      'x-page-id': req.headers['x-page-id'],
      'x-whop-company-id': req.headers['x-whop-company-id'],
      'x-company-id': req.headers['x-company-id'],
      'referer': req.headers.referer
    },
    query: req.query,
    whop_apps_extraction: extractCompanyFromWhopApps(req.headers.referer),
    standard_referer_extraction: extractCompanyFromReferer(req.headers.referer)
  });
  
  for (const source of sources) {
    if (source && typeof source === 'string' && source.trim()) {
      const cleanId = source.trim();
      console.log(`🏢 ✅ FOUND COMPANY ID: ${cleanId}`);
      return cleanId;
    }
  }
  
  console.log('⚠️ No company ID found in any source');
  return null;
}

// NEW: Extract company ID from Whop's internal app structure
function extractCompanyFromWhopApps(referer) {
  if (!referer || typeof referer !== 'string') return null;
  
  console.log(`🔍 WHOP APPS EXTRACTION: Analyzing ${referer}`);
  
  // Skip obviously non-Whop URLs
  if (!referer.includes('whop')) {
    console.log(`❌ Not a Whop URL: ${referer}`);
    return null;
  }
  
  // Whop's internal app structure: https://[company-id].apps.whop.com/
  const whopAppsPattern = /^https?:\/\/([a-zA-Z0-9]+)\.apps\.whop\.com/;
  const match = referer.match(whopAppsPattern);
  
  if (match && match[1] && match[1].length > 3) { // Ensure company ID is reasonable length
    console.log(`🎯 ✅ WHOP APPS COMPANY ID EXTRACTED: ${match[1]}`);
    return match[1];
  }
  
  console.log(`❌ No valid Whop apps pattern found in: ${referer}`);
  return null;
}

function extractCompanyFromReferer(referer) {
  if (!referer) return null;
  
  console.log(`🔍 STANDARD REFERER EXTRACTION: ${referer}`);
  
  // Enhanced Whop URL patterns for app store apps
  const patterns = [
    // Whop app store and embedded app patterns
    /\/apps\/([^\/\?]+)/,               // whop.com/apps/app-id
    /\/([^\/]+)\/apps\/([^\/\?]+)/,     // whop.com/company/apps/app-id
    /whop\.com\/([^\/]+)\/[^\/]*app/,   // whop.com/company/member-directory-app
    
    // Business/company ID patterns  
    /\/(biz_[^\/\?]+)/,                 // Direct biz_ IDs
    /\/company\/([^\/\?]+)/,
    /\/business\/([^\/\?]+)/,
    /company_id=([^&\?]+)/,
    /business_id=([^&\?]+)/,
    /page_id=([^&\?]+)/,
    
    // Whop subdomain patterns
    /^https?:\/\/([^\.]+)\.whop\.com/,
    
    // Whop main domain patterns
    /whop\.com\/([^\/]+)\/[^\/]+/,      // whop.com/username/product
    /whop\.com\/([^\/\?]+)/,            // whop.com/username
    
    // Product/dashboard specific patterns
    /\/([^\/]+)\/dashboard/,
    /\/([^\/]+)\/members/,
    /\/([^\/]+)\/apps/
  ];
  
  for (const pattern of patterns) {
    const match = referer.match(pattern);
    if (match && match[1] && match[1] !== 'www' && match[1] !== 'app' && match[1] !== 'apps') {
      console.log(`🎯 Extracted from standard referer: ${match[1]} (pattern: ${pattern})`);
      return match[1];
    }
  }
  
  return null;
}

// ==================== APP STORE INSTALLATION DETECTION - FIXED ====================

async function detectAndHandleNewInstallation(req) {
  const companyId = extractCompanyId(req);
  
  if (!companyId) {
    console.log('⚠️ Cannot detect installation - no company ID found');
    return null;
  }
  
  console.log(`🔍 Checking if ${companyId} is a new installation...`);
  
  try {
    // Check if company directory already exists
    const existingCompany = await pool.query(`
      SELECT company_id, installed_at, installation_source 
      FROM whop_companies 
      WHERE company_id = $1
    `, [companyId]);
    
    if (existingCompany.rows.length > 0) {
      console.log(`✅ EXISTING directory found for ${companyId} (created: ${existingCompany.rows[0].installed_at})`);
      
      // Update last activity
      await pool.query(`
        UPDATE whop_companies 
        SET last_activity = CURRENT_TIMESTAMP 
        WHERE company_id = $1
      `, [companyId]);
      
      return {
        isNewInstallation: false,
        companyId,
        company: existingCompany.rows[0]
      };
    }
    
    // This is a new installation! Create the directory
    console.log(`🎉 ✅ NEW INSTALLATION DETECTED: ${companyId}`);
    
    // Create company directory
    const newCompany = await pool.query(`
      INSERT INTO whop_companies (
        company_id, 
        company_name, 
        installed_at, 
        first_viewed_at, 
        last_activity, 
        installation_source,
        app_version,
        status
      ) VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'app_store', '3.2.1', 'active')
      RETURNING *
    `, [companyId, generateCompanyName(companyId)]);
    
    // Track the installation (optional, no foreign key constraint)
    try {
      await pool.query(`
        INSERT INTO app_installations (
          company_id, 
          installed_at, 
          installation_method, 
          user_agent, 
          referer_url,
          installation_data
        ) VALUES ($1, CURRENT_TIMESTAMP, 'first_view', $2, $3, $4)
      `, [
        companyId,
        req.headers['user-agent'] || '',
        req.headers.referer || '',
        JSON.stringify({
          ip: req.ip || req.connection.remoteAddress,
          headers: {
            'x-page-id': req.headers['x-page-id'],
            'x-whop-company-id': req.headers['x-whop-company-id']
          },
          whop_apps_detected: !!extractCompanyFromWhopApps(req.headers.referer),
          timestamp: new Date().toISOString()
        })
      ]);
    } catch (installError) {
      console.log('⚠️ Could not track installation (non-critical):', installError.message);
    }
    
    console.log(`🎯 ✅ DIRECTORY CREATED: ${companyId} - Ready for members!`);
    console.log(`📊 Company Name: ${newCompany.rows[0].company_name}`);
    
    return {
      isNewInstallation: true,
      companyId,
      company: newCompany.rows[0]
    };
    
  } catch (error) {
    console.error('❌ Error detecting/handling installation:', error);
    return null;
  }
}

function generateCompanyName(companyId) {
  // Generate a friendly company name from the ID
  if (companyId.startsWith('biz_')) {
    return `${companyId.replace('biz_', '').replace(/[^a-zA-Z0-9]/g, ' ')} Community`;
  }
  
  // For Whop internal IDs, create a more readable name
  if (companyId.length > 10 && /^[a-zA-Z0-9]+$/.test(companyId)) {
    return `${companyId.substring(0, 8).toUpperCase()} Directory`;
  }
  
  // Clean up the ID to make it more readable
  const cleanName = companyId
    .replace(/[_-]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, l => l.toUpperCase())
    .trim();
    
  return `${cleanName} Directory`;
}

// ==================== API ROUTES ====================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Whop App Store Ready Directory is healthy!', 
    timestamp: new Date().toISOString(),
    version: '3.2.1',
    features: [
      'auto-installation-detection',
      'whop-apps-support',
      'app-store-ready',
      'multi-tenant-directories',
      'enhanced-company-detection',
      'webhook-member-sync',
      'backward-compatible'
    ]
  });
});

// Enhanced test endpoint
app.get('/api/test', async (req, res) => {
  const extractedId = extractCompanyId(req);
  
  // Test installation detection
  const installationResult = extractedId ? await detectAndHandleNewInstallation(req) : null;
  
  // Get current stats
  let stats = {};
  try {
    const statsResult = await pool.query(`
      SELECT 
        COUNT(*) as total_directories,
        COUNT(CASE WHEN status = 'active' THEN 1 END) as active_directories,
        (SELECT COUNT(*) FROM whop_members WHERE status = 'active') as total_members
      FROM whop_companies
    `);
    stats = statsResult.rows[0];
  } catch (error) {
    console.error('Error getting stats:', error);
  }
  
  res.json({ 
    success: true, 
    extracted_company_id: extractedId || 'none',
    installation_detection: installationResult,
    system_stats: stats,
    detection_debug: {
      url_info: {
        host: req.get('host'),
        original_url: req.originalUrl,
        full_url: `${req.get('host')}${req.originalUrl}`,
        user_agent: req.get('user-agent')
      },
      headers: {
        'x-page-id': req.headers['x-page-id'] || 'missing',
        'x-whop-company-id': req.headers['x-whop-company-id'] || 'missing',
        'x-company-id': req.headers['x-company-id'] || 'missing',
        'referer': req.headers.referer || 'missing'
      },
      query_params: req.query,
      whop_apps_extraction: extractCompanyFromWhopApps(req.headers.referer),
      standard_referer_extraction: extractCompanyFromReferer(req.headers.referer)
    },
    app_store_info: {
      version: '3.2.1',
      auto_installation: 'enabled',
      whop_apps_support: 'enabled',
      whop_embedding_support: 'enhanced',
      webhook_endpoint: '/webhook/whop',
      supported_events: [
        'membership_went_valid',
        'membership_went_invalid',
        'membership_updated'
      ]
    },
    timestamp: new Date().toISOString()
  });
});

// Enhanced members endpoint with automatic installation detection
app.get('/api/members/:companyId?', async (req, res) => {
  let { companyId } = req.params;
  
  console.log(`📡 Members API called with companyId: ${companyId}`);
  
  // Handle installation detection on members API call
  let installationResult = null;
  
  if (!companyId || companyId === 'auto') {
    // Try to detect installation
    installationResult = await detectAndHandleNewInstallation(req);
    
    if (installationResult) {
      companyId = installationResult.companyId;
      console.log(`✅ Auto-detected company: ${companyId}`);
    }
  }
  
  // Ensure we have a valid company ID (not "auto")
  if (!companyId || companyId === 'auto') {
    // Try to get available companies for selection
    const availableCompanies = await getAvailableCompanies();
    
    return res.status(400).json({
      success: false,
      error: 'Company auto-detection failed',
      help: 'Please access this app from within your Whop dashboard where it was installed',
      available_companies: availableCompanies,
      debug: {
        original_param: req.params.companyId,
        extracted_id: extractCompanyId(req),
        referer: req.headers.referer,
        installation_result: installationResult,
        whop_apps_detection: extractCompanyFromWhopApps(req.headers.referer),
        url_info: {
          host: req.get('host'),
          original_url: req.originalUrl,
          full_url: `${req.get('host')}${req.originalUrl}`
        }
      },
      suggestion: 'If you are trying to access this app, please visit it through your Whop dashboard or provide a company ID in the URL'
    });
  }
  
  try {
    // Ensure we use the correct detected company ID for the database query
    let queryCompanyId = installationResult?.companyId || companyId;
    
    if (!queryCompanyId || queryCompanyId === 'auto') {
      throw new Error('No valid company ID detected');
    }
    
    console.log(`🗄️ Querying database for company: ${queryCompanyId}`);
    
    // Get members for this company - BACKWARD COMPATIBLE QUERY
    const result = await pool.query(`
      SELECT 
        m.id, m.user_id, m.membership_id, m.email, m.name, m.username, 
        m.custom_fields, m.joined_at, m.status, m.updated_at,
        c.company_name, c.installed_at as directory_created
      FROM whop_members m
      RIGHT JOIN whop_companies c ON m.company_id = c.company_id
      WHERE c.company_id = $1 AND c.status = 'active'
      ORDER BY m.joined_at DESC
    `, [queryCompanyId]);
    
    const members = result.rows
      .filter(row => row.user_id) // Only include actual members
      .map(member => ({
        id: member.id,
        user_id: member.user_id,
        membership_id: member.membership_id,
        email: member.email,
        name: member.name,
        username: member.username,
        waitlist_responses: member.custom_fields || {},
        custom_fields: member.custom_fields || {},
        joined_at: member.joined_at,
        status: member.status || 'active',
        updated_at: member.updated_at
      }));

    const companyInfo = result.rows[0] || {};
    const isNewDirectory = installationResult?.isNewInstallation || false;

    console.log(`✅ Returning ${members.length} members for ${queryCompanyId} (${isNewDirectory ? 'NEW' : 'EXISTING'} directory)`);

    // Ensure we return the detected company ID, not "auto"
    const responseCompanyId = installationResult?.companyId || companyId;
    
    res.json({
      success: true,
      members: members,
      count: members.length,
      company_id: responseCompanyId,  // Use the detected ID, not the "auto" parameter
      company_name: companyInfo.company_name || generateCompanyName(responseCompanyId),
      is_new_installation: isNewDirectory,
      directory_created: companyInfo.directory_created,
      detection_method: installationResult ? 'whop_apps_auto_detect' : 'manual',
      detected_from: extractCompanyFromWhopApps(req.headers.referer) ? 'whop_apps_domain' : 'standard_detection',
      message: isNewDirectory ? 
        'Welcome! Your member directory has been created. Members will appear here as they join your community.' :
        `Loaded ${members.length} members from your directory.`,
      debug_info: {
        original_param: req.params.companyId,
        detected_id: extractCompanyId(req),
        whop_apps_extraction: extractCompanyFromWhopApps(req.headers.referer),
        installation_result: installationResult
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    const errorCompanyId = installationResult?.companyId || companyId;
    console.error('❌ Error fetching members:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      company_id: errorCompanyId === 'auto' ? 'detection_failed' : errorCompanyId
    });
  }
});

// Get available companies (for debugging/selection)
async function getAvailableCompanies() {
  try {
    const result = await pool.query(`
      SELECT 
        c.company_id,
        c.company_name,
        c.installed_at as created_at,
        COUNT(m.id) as member_count,
        MAX(c.last_activity) as latest_activity
      FROM whop_companies c
      LEFT JOIN whop_members m ON c.company_id = m.company_id AND m.status = 'active'
      WHERE c.status = 'active'
      GROUP BY c.company_id, c.company_name, c.installed_at
      ORDER BY c.installed_at DESC
      LIMIT 20
    `);
    return result.rows;
  } catch (error) {
    console.error('Error getting available companies:', error);
    return [];
  }
}

// Installation stats endpoint
app.get('/api/installations', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total_installations,
        COUNT(CASE WHEN installed_at > NOW() - INTERVAL '24 hours' THEN 1 END) as today,
        COUNT(CASE WHEN installed_at > NOW() - INTERVAL '7 days' THEN 1 END) as this_week,
        COUNT(CASE WHEN installed_at > NOW() - INTERVAL '30 days' THEN 1 END) as this_month
      FROM whop_companies
    `);
    
    const recent = await pool.query(`
      SELECT 
        wc.company_id,
        wc.installed_at,
        wc.company_name,
        (SELECT COUNT(*) FROM whop_members WHERE company_id = wc.company_id AND status = 'active') as member_count
      FROM whop_companies wc
      ORDER BY wc.installed_at DESC
      LIMIT 10
    `);
    
    res.json({
      success: true,
      stats: stats.rows[0],
      recent_installations: recent.rows,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Error getting installation stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

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
      return res.status(400).json({ 
        error: 'Invalid webhook payload - missing event_type or action',
        received_keys: Object.keys(req.body)
      });
    }

    if (!data) {
      console.error('❌ Invalid webhook payload - missing data');
      return res.status(400).json({ error: 'Invalid webhook payload - missing data' });
    }

    // Extract company ID from webhook
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
      return res.status(400).json({ 
        error: 'No company ID found in webhook payload',
        help: 'Company ID should be in page_id, company_id, or headers'
      });
    }

    console.log(`📨 Processing ${eventType} for company ${companyId}`);
    
    // Ensure company directory exists (create if needed)
    await ensureCompanyExists(companyId);

    // Handle different webhook events
    switch (eventType) {
      case 'membership_went_valid':
      case 'membership.went_valid':
      case 'membership_created':
      case 'membership.created':
      case 'user_joined':
      case 'user.joined':
        await handleMembershipValid(companyId, data);
        break;
        
      case 'membership_went_invalid':
      case 'membership.went_invalid':
      case 'membership_cancelled':
      case 'membership.cancelled':
      case 'user_left':
      case 'user.left':
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
        // Still process as potential membership event
        if (data.status === 'completed' && data.valid === true) {
          console.log('🔄 Treating as membership validation event');
          await handleMembershipValid(companyId, data);
        }
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

// Handle valid membership - adds members to directories
async function handleMembershipValid(companyId, data) {
  const userId = data.user_id || data.user;
  const membershipId = data.id || data.membership_id;
  
  if (!userId) {
    console.error('❌ No user_id in membership webhook');
    return;
  }

  console.log(`👤 MEMBER JOIN: Processing ${userId} for company ${companyId}`);
  
  // Ensure company directory exists
  await ensureCompanyExists(companyId);
  
  // Parse member data
  let joinedAt = new Date();
  if (data.created_at) {
    const timestamp = parseInt(data.created_at);
    if (timestamp > 946684800) { // Convert from seconds to milliseconds
      joinedAt = new Date(timestamp * 1000);
    } else {
      joinedAt = new Date(data.created_at);
    }
  }

  const customFields = data.custom_field_responses || 
                      data.waitlist_responses || 
                      data.custom_fields || 
                      data.responses ||
                      data.metadata ||
                      {};

  const userEmail = data.email || 
                   data.user_email || 
                   data.user?.email ||
                   null;
                   
  const userName = data.name || 
                  data.display_name || 
                  data.user_name ||
                  data.user?.name ||
                  data.user?.display_name ||
                  (data.first_name && data.last_name ? `${data.first_name} ${data.last_name}` : null) ||
                  null;
                  
  const username = data.username || 
                  data.user_username || 
                  data.user?.username ||
                  null;

  try {
    const result = await pool.query(`
      INSERT INTO whop_members (
        user_id, membership_id, company_id, email, name, username, 
        custom_fields, joined_at, status, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', CURRENT_TIMESTAMP)
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
    console.log(`✅ MEMBER ADDED: ${userId} (${member.name || 'Anonymous'}) to directory ${companyId}`);
    
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
    const result = await pool.query(`
      UPDATE whop_members 
      SET status = 'inactive', updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $1 AND company_id = $2
      RETURNING name, email
    `, [userId, companyId]);
    
    if (result.rows.length > 0) {
      const member = result.rows[0];
      console.log(`✅ Member ${userId} (${member.name || 'Anonymous'}) set to inactive in ${companyId}`);
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
      console.log(`✅ Member ${userId} updated in ${companyId}`);
    } else {
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
      INSERT INTO whop_companies (company_id, company_name, installation_source) 
      VALUES ($1, $2, 'webhook_first_contact')
      ON CONFLICT (company_id) 
      DO UPDATE SET last_activity = CURRENT_TIMESTAMP
    `, [companyId, generateCompanyName(companyId)]);
    
    console.log(`✅ Ensured directory exists for ${companyId}`);
  } catch (error) {
    console.error('⚠️ Error ensuring company exists:', error);
  }
}

// ==================== FRONTEND ROUTES WITH INSTALLATION DETECTION ====================

// Handle favicon and other static assets (prevent company detection attempts)
app.get('/favicon.ico', (req, res) => {
  res.status(204).end(); // No Content
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send('User-agent: *\nDisallow: /api/\nAllow: /');
});

// Main app route with installation detection
app.get('/', async (req, res) => {
  console.log('🏠 Main app route accessed');
  
  // Detect and handle new installations
  const installationResult = await detectAndHandleNewInstallation(req);
  
  if (installationResult?.isNewInstallation) {
    console.log(`🎉 NEW APP INSTALLATION: ${installationResult.companyId} - Serving fresh directory`);
  }
  
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Directory-specific route (for direct access)
app.get('/directory/:companyId', async (req, res) => {
  const { companyId } = req.params;
  console.log(`📂 Direct directory access: ${companyId}`);
  
  try {
    // Check if directory exists
    const company = await pool.query(`
      SELECT company_id, company_name, installed_at 
      FROM whop_companies 
      WHERE company_id = $1 AND status = 'active'
    `, [companyId]);
    
    if (company.rows.length === 0) {
      return res.status(404).json({
        error: 'Directory not found',
        company_id: companyId,
        help: 'This directory may not have been created yet. Try accessing through your Whop dashboard.'
      });
    }
    
    // Update last activity
    await pool.query(`
      UPDATE whop_companies 
      SET last_activity = CURRENT_TIMESTAMP 
      WHERE company_id = $1
    `, [companyId]);
    
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
    
  } catch (error) {
    console.error('Error accessing directory:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 404 handler for API routes
app.use('/api/*', (req, res) => {
  res.status(404).json({ 
    error: 'API endpoint not found',
    available_endpoints: [
      'GET /api/health',
      'GET /api/test',
      'GET /api/members/auto (auto-detects installation)',
      'GET /api/installations (stats)',
      'POST /webhook/whop',
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
  console.log('🎉 ===== WHOP APP STORE READY MEMBER DIRECTORY - FINAL =====');
  console.log(`🚀 Server running on port ${port}`);
  console.log(`📱 App URL: ${process.env.NODE_ENV === 'production' ? 'https://your-app-domain.railway.app' : `http://localhost:${port}`}/`);
  console.log(`🔗 Webhook URL: ${process.env.NODE_ENV === 'production' ? 'https://your-app-domain.railway.app' : `http://localhost:${port}`}/webhook/whop`);
  console.log('');
  console.log('🏪 APP STORE FEATURES:');
  console.log('   ✅ Automatic directory creation on first view');
  console.log('   ✅ Whop internal app detection (*.apps.whop.com)');
  console.log('   ✅ Multi-tenant support (separate directories per company)');
  console.log('   ✅ Installation tracking and analytics');
  console.log('   ✅ Enhanced company ID detection');
  console.log('   ✅ Webhook-based member synchronization');
  console.log('   ✅ Backward compatible with existing databases');
  console.log('');
  console.log('📋 How App Store Installation Works:');
  console.log('   1️⃣  USER INSTALLS → App added to their Whop dashboard');
  console.log('   2️⃣  FIRST VIEW → Auto-detects company from *.apps.whop.com');
  console.log('   3️⃣  DIRECTORY CREATED → New installation detected and directory created');
  console.log('   4️⃣  MEMBERS JOIN → Webhooks automatically add them');
  console.log('   5️⃣  SUBSEQUENT VIEWS → Shows populated directory');
  console.log('');
  console.log('🔧 Supported Whop Webhook Events:');
  console.log('   👤 membership_went_valid → Add member to directory');
  console.log('   ❌ membership_went_invalid → Remove member');
  console.log('   ✏️  membership_updated → Update member info');
  console.log('');
  console.log('🎯 Ready for Whop App Store submission!');
  console.log('');
});

module.exports = app;