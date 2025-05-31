# Whop Member Directory System

## Quick Setup Guide

### 1. Deploy to Railway (Recommended - Easiest)

1. Fork this repository to your GitHub
2. Go to [Railway.app](https://railway.app)
3. Click "Deploy from GitHub repo"
4. Select your forked repository
5. Railway will auto-deploy and provide:
   - Database (PostgreSQL)
   - Your app URL
   - Environment variables

### 2. Configure Your Whop Integration

1. Go to your Railway app dashboard
2. Copy your app URL (something like: `https://your-app-name.railway.app`)
3. In Whop Developer Dashboard:
   - Create new webhook
   - URL: `https://your-app-name.railway.app/webhook/whop`
   - Select events: `membership_went_valid`, `membership_went_invalid`
4. Copy webhook secret from Whop

### 3. Register Your Whop Group

Make a POST request to register your group:

```bash
curl -X POST https://your-app-name.railway.app/api/register-group \
  -H "Content-Type: application/json" \
  -d '{
    "whop_company_id": "your_whop_company_id",
    "group_name": "Your Community Name",
    "webhook_secret": "your_webhook_secret_from_whop"
  }'
```

### 4. Embed Member Directory

Add this to your Whop community:

```html
<iframe 
  src="https://your-app-name.railway.app/directory.html?company=your_whop_company_id" 
  width="100%" 
  height="800px" 
  frameborder="0">
</iframe>
```

## Alternative Deployment Options

### Render.com
1. Connect GitHub repo to Render
2. Use `render.yaml` configuration
3. Add PostgreSQL database

### Vercel + Supabase
1. Deploy to Vercel
2. Create Supabase database
3. Add DATABASE_URL to Vercel environment

## Environment Variables

```
DATABASE_URL=postgresql://...
NODE_ENV=production
PORT=3000
BASE_URL=https://your-domain.com
```

## Webhook Events

Your system will automatically:
- Add members when `membership_went_valid` fires
- Remove members when `membership_went_invalid` fires
- Store waitlist data for approved members

## Waitlist Data Collection

Since Whop doesn't provide waitlist data via webhook, you have options:

1. **Manual Export**: Export waitlist CSV and upload via API
2. **Form Integration**: Create custom waitlist form that posts to your API
3. **Whop Integration**: Wait for Whop to add waitlist webhook events

## API Endpoints

- `POST /webhook/whop` - Whop webhook handler
- `POST /api/register-group` - Register new Whop group
- `GET /api/directory/:companyId` - Get member directory
- `POST /api/waitlist/:companyId` - Add waitlist responses
- `GET /health` - Health check

## Security Features

- Webhook signature verification
- Rate limiting
- SQL injection protection
- XSS protection
- CORS configuration

## Customization

Each group can customize:
- Community name and branding
- Custom questions displayed in directory
- Member profile fields
- Directory styling

## Support

For issues or questions:
1. Check the logs in your hosting platform
2. Test webhook delivery in Whop dashboard
3. Verify database connections
4. Check API responses with curl/Postman

## Scaling

This system is designed to handle:
- Multiple Whop communities
- Thousands of members per community
- Real-time updates
- High webhook volume

For larger scale, consider:
- Database connection pooling
- Redis caching
- CDN for static assets
- Load balancing

## Next Steps

1. Deploy the system
2. Test with your Whop community
3. Add waitlist data collection
4. Customize directory appearance
5. Add advanced features (search, filtering, etc.)

## Future Enhancements

- LLM-powered member matching
- Advanced search and filtering
- Member messaging system
- Analytics dashboard
- Mobile app integration
- Custom member profiles
- Integration with other platforms 