# Real Google OAuth Setup Guide

## Quick Start

### 1. Create Google OAuth Credentials

1. Navigate to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project or select an existing one
3. Go to **APIs & Services** → **Credentials**
4. Click **+ Create Credentials** → **OAuth 2.0 Client ID**
5. If prompted, first configure the OAuth consent screen:
   - Choose **External**
   - Fill in required fields: App name, User support email, Developer contact
   - Add scopes: `profile`, `email` (already configured in backend)
   - Add test users if in development mode
6. Select **Web application** as application type
7. Add authorized redirect URIs:
   ```
   http://localhost:3002/api/auth/google/callback
   ```
8. Click **Create**
9. Copy your **Client ID** and **Client Secret**

### 2. Configure Environment Variables

1. Create a `.env` file in your project root (copy from `.env.example`):
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` and add your credentials:
   ```
   GOOGLE_CLIENT_ID=your_client_id_here.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=your_client_secret_here
   GOOGLE_REDIRECT_URI=http://localhost:3002/api/auth/google/callback
   PORT=3002
   NODE_ENV=development
   SESSION_SECRET=generate_a_random_secret_here
   ```

   **Generate SESSION_SECRET** (run in terminal):
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

3. **IMPORTANT: Do NOT commit `.env` to version control!**

### 3. Start the Server

```bash
npm run dev
```

The server will start on `http://localhost:3002`

### 4. Test OAuth Flow

1. **From Landing Page**: Click "Google OAuth" button → Redirects to Google login
2. **From Login Page**: Click "Continue with Google" → Redirects to Google login
3. **From Signup Page**: Click "Continue with Google" → Redirects to Google login

**OAuth Flow:**
- User clicks button → Redirected to Google login (`/api/auth/google`)
- User grants permission → Google redirects to callback (`/api/auth/google/callback`)
- Backend exchanges auth code for access token
- Backend retrieves user info (email, name, picture)
- Session created with user data
- User redirected to `/dashboard`

### 5. Session Management

**Backend Endpoints:**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/auth/google` | GET | Initiates OAuth login |
| `/api/auth/google/callback` | GET | OAuth callback handler (Google redirects here) |
| `/api/auth/session` | GET | Check if user is authenticated |
| `/api/auth/logout` | GET | Logout and destroy session |

**Session Data Stored:**
```javascript
{
  id: 'google_user_id',
  email: 'user@example.com',
  name: 'User Name',
  picture: 'https://...',
  role: 'user',
  loggedInAt: '2026-03-23T...',
  authProvider: 'google'
}
```

### 6. Frontend Session Verification

Dashboard and admin pages now:
- Check session with `/api/auth/session` on page load
- Redirect to login if no session
- Display user name from backend session
- Support logout via `/api/auth/logout`

Falls back to localStorage for backwards compatibility.

## Troubleshooting

### "Invalid Client" Error
- Verify `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are correct
- Check that credentials are pasted completely (no extra spaces)

### "Redirect URI Mismatch"
- Ensure `GOOGLE_REDIRECT_URI` matches exactly in both:
  - Google Cloud Console (Credentials page)
  - `.env` file
- Don't add trailing slashes

### Session Not Persisting
- Check that cookies are enabled in browser
- Verify `SESSION_SECRET` is set in `.env`
- Open DevTools → Application → Cookies to see session cookie

### User Not Redirected After Login
- Check browser console for errors
- Verify `/api/auth/session` returns `authenticated: true`
- Check server logs for OAuth exchange errors

### "Cannot POST /api/auth/google/callback"
- Ensure server is running with OAuth routes loaded
- Check that server.js has been updated with OAuth endpoints
- Verify package.json has `axios` and `express-session`

## Production Deployment

**Before deploying to production:**

1. Update `GOOGLE_REDIRECT_URI` to production domain:
   ```
   https://yourdomain.com/api/auth/google/callback
   ```

2. Add production domain to Google Cloud Console Credentials

3. Change `NODE_ENV=production` in `.env`

4. Set `SESSION_SECRET` to a strong random value

5. Consider using a session store (Redis, MongoDB) instead of in-memory:
   ```javascript
   const RedisStore = require('connect-redis');
   app.use(session({
     store: new RedisStore({ client: redisClient }),
     // ... other options
   }));
   ```

## Optional: GitHub OAuth

To add GitHub OAuth (similar setup):
1. Go to GitHub Settings → Developer settings → OAuth Apps
2. Create new OAuth App
3. Add callback: `http://localhost:3002/api/auth/github/callback`
4. Similar backend implementation pattern

## Testing Checklist

- ✅ Server starts without errors
- ✅ Can access http://localhost:3002
- ✅ Google login button visible on landing/login pages
- ✅ Clicking button redirects to Google login screen
- ✅ After approval, redirects back to dashboard
- ✅ Dashboard displays user name from session
- ✅ Logout button works and clears session
- ✅ Refresh dashboard page keeps user logged in (session persists)
- ✅ Direct access to `/dashboard` redirects to login if not authenticated
