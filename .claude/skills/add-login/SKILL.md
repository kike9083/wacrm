---
name: add-login
description: "Inyectar sistema de autenticacion completo: login, signup, password reset, profiles, Google OAuth, y Appwrite Permissions. Activar cuando el usuario dice: necesito login, agregar registro, autenticacion, que los usuarios puedan entrar, crear cuentas, o proteger rutas."
allowed-tools: Read, Write, Edit, Bash
---

# Sistema de Autenticacion Completo

Inyecta autenticacion B2B production-ready con Appwrite + Next.js 16.

**NO preguntes. Ejecuta el Golden Path completo.**

---

## Contexto Tecnico

**Next.js 16:**
- `proxy.ts` (en la raiz, actua como el middleware de rutas de Next.js)
- Utiliza la cookie nativa de Appwrite `a_session_[projectId]` para mantener la sesion sincronizada entre cliente y servidor (SSR).

**Appwrite Sessions:**
- Server: `createSessionClient()` extrae la cookie de sesion y actua en nombre del usuario autenticado.
- Admin: `createAdminClient()` utiliza la API Key con permisos administrativos (`databases.write`, `users.write`, etc.).

**Patron Profiles:**
- Los perfiles se almacenan en una coleccion de Appwrite llamada `profiles` con ID de documento igual al ID del usuario (`userId`).
- Se crea el perfil del usuario inmediatamente despues del registro en la accion del servidor.

---

## Archivos a Crear

### 1. `proxy.ts` (root)

```typescript
import { NextResponse, type NextRequest } from 'next/server'

export async function proxy(request: NextRequest) {
  const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || process.env.APPWRITE_PROJECT_ID
  const sessionCookieName = `a_session_${projectId}`
  const session = request.cookies.get(sessionCookieName)

  const isProtectedRoute = request.nextUrl.pathname.startsWith('/dashboard')
  const isAuthRoute = request.nextUrl.pathname.startsWith('/login') ||
                      request.nextUrl.pathname.startsWith('/signup') ||
                      request.nextUrl.pathname.startsWith('/forgot-password') ||
                      request.nextUrl.pathname.startsWith('/update-password')

  if (isProtectedRoute && !session) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  if (isAuthRoute && session) {
    return NextResponse.redirect(new URL('/dashboard', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
```

### 2. `src/lib/appwrite/server.ts`

```typescript
import { Client, Account, Databases } from 'node-appwrite'
import { cookies } from 'next/headers'

export async function createSessionClient() {
  const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || process.env.APPWRITE_PROJECT_ID
  const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT || process.env.APPWRITE_ENDPOINT || 'https://cloud.appwrite.io/v1'

  const client = new Client()
    .setEndpoint(endpoint)
    .setProject(projectId!)

  const cookieStore = await cookies()
  const sessionCookieName = `a_session_${projectId}`
  const session = cookieStore.get(sessionCookieName)

  if (session) {
    client.setSession(session.value)
  }

  return {
    get account() {
      return new Account(client)
    },
    get databases() {
      return new Databases(client)
    },
  }
}

export async function createAdminClient() {
  const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || process.env.APPWRITE_PROJECT_ID
  const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT || process.env.APPWRITE_ENDPOINT || 'https://cloud.appwrite.io/v1'

  const client = new Client()
    .setEndpoint(endpoint)
    .setProject(projectId!)
    .setKey(process.env.APPWRITE_API_KEY!)

  return {
    get account() {
      return new Account(client)
    },
    get databases() {
      return new Databases(client)
    },
  }
}
```

### 3. `src/lib/appwrite/client.ts`

```typescript
import { Client, Account, Databases } from 'appwrite'

const client = new Client()
  .setEndpoint(process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT || process.env.APPWRITE_ENDPOINT || 'https://cloud.appwrite.io/v1')
  .setProject(process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || process.env.APPWRITE_PROJECT_ID!)

export const account = new Account(client)
export const databases = new Databases(client)
```

### 4. `src/types/database.ts`

```typescript
export interface Profile {
  $id: string
  email: string
  full_name: string | null
  avatar_url: string | null
  $createdAt: string
  $updatedAt: string
}
```

### 5. `src/actions/auth.ts`

```typescript
'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { createAdminClient, createSessionClient } from '@/lib/appwrite/server'
import { ID } from 'node-appwrite'

export async function login(formData: FormData) {
  const email = formData.get('email') as string
  const password = formData.get('password') as string

  try {
    const { account } = await createAdminClient()
    const session = await account.createEmailPasswordSession(email, password)

    const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || process.env.APPWRITE_PROJECT_ID
    const sessionCookieName = `a_session_${projectId}`
    cookieStore.set(sessionCookieName, session.secret, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      expires: new Date(session.expire),
    })
  } catch (error: any) {
    return { error: error.message }
  }

  revalidatePath('/', 'layout')
  redirect('/dashboard')
}

export async function signup(formData: FormData) {
  const email = formData.get('email') as string
  const password = formData.get('password') as string
  const name = formData.get('name') as string || email.split('@')[0]

  try {
    const { account, databases } = await createAdminClient()
    
    // 1. Crear cuenta
    const userId = ID.unique()
    await account.create(userId, email, password, name)

    // 2. Iniciar sesion para obtener token
    const session = await account.createEmailPasswordSession(email, password)

    // 3. Guardar cookie
    const cookieStore = await cookies()
    const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || process.env.APPWRITE_PROJECT_ID
    const sessionCookieName = `a_session_${projectId}`
    cookieStore.set(sessionCookieName, session.secret, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      expires: new Date(session.expire),
    })

    // 4. Crear perfil en coleccion 'profiles'
    await databases.createDocument(
      process.env.APPWRITE_DATABASE_ID!,
      'profiles',
      userId,
      {
        email,
        full_name: name,
        avatar_url: null,
      }
    )
  } catch (error: any) {
    return { error: error.message }
  }

  revalidatePath('/', 'layout')
  redirect('/dashboard')
}

export async function signout() {
  try {
    const { account } = await createSessionClient()
    await account.deleteSession('current')
  } catch {}

  const cookieStore = await cookies()
  const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || process.env.APPWRITE_PROJECT_ID
  const sessionCookieName = `a_session_${projectId}`
  cookieStore.delete(sessionCookieName)
  
  revalidatePath('/', 'layout')
  redirect('/login')
}

export async function resetPassword(formData: FormData) {
  const email = formData.get('email') as string

  try {
    const { account } = await createAdminClient()
    await account.createRecovery(
      email,
      `${process.env.NEXT_PUBLIC_SITE_URL}/update-password`
    )
  } catch (error: any) {
    return { error: error.message }
  }

  return { success: true }
}

export async function updatePassword(formData: FormData) {
  const password = formData.get('password') as string
  const secret = formData.get('secret') as string
  const userId = formData.get('userId') as string

  try {
    const { account } = await createAdminClient()
    await account.updateRecoveryComplete(userId, secret, password, password)
  } catch (error: any) {
    return { error: error.message }
  }

  redirect('/login')
}

export async function updateProfile(formData: FormData) {
  try {
    const { account, databases } = await createSessionClient()
    const user = await account.get()

    await databases.updateDocument(
      process.env.APPWRITE_DATABASE_ID!,
      'profiles',
      user.$id,
      {
        full_name: formData.get('full_name') as string,
      }
    )
  } catch (error: any) {
    return { error: error.message }
  }

  revalidatePath('/', 'layout')
  return { success: true }
}
```

### 6. `src/hooks/useAuth.ts`

```typescript
'use client'

import { useEffect, useState } from 'react'
import { account, databases } from '@/lib/appwrite/client'
import type { Models } from 'appwrite'
import type { Profile } from '@/types/database'

export function useAuth() {
  const [user, setUser] = useState<Models.User<Models.Preferences> | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function getProfile(userId: string) {
      try {
        const data = await databases.getDocument(
          process.env.NEXT_PUBLIC_APPWRITE_DATABASE_ID || 'profiles_db',
          'profiles',
          userId
        ) as unknown as Profile
        setProfile(data)
      } catch (error) {
        console.error('Error fetching profile:', error)
      }
    }

    account.get()
      .then((currentUser) => {
        setUser(currentUser)
        getProfile(currentUser.$id)
        setLoading(false)
      })
      .catch(() => {
        setUser(null)
        setProfile(null)
        setLoading(false)
      })
  }, [])

  return { user, profile, loading }
}
```

### 7. `src/features/auth/components/LoginForm.tsx`

```tsx
'use client'

import { useState } from 'react'
import Link from 'next/link'
import { login } from '@/actions/auth'
import { GoogleSignInButton } from './GoogleSignInButton'
import { AuthDivider } from './AuthDivider'

export function LoginForm() {
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(formData: FormData) {
    setLoading(true)
    setError(null)

    const result = await login(formData)

    if (result?.error) {
      setError(result.error)
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <GoogleSignInButton />

      <AuthDivider />

      <form action={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="email" className="block text-sm font-medium">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <div>
          <label htmlFor="password" className="block text-sm font-medium">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        {error && (
          <p className="text-sm text-red-600">{error}</p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? 'Iniciando sesion...' : 'Sign In'}
        </button>

        <p className="text-center text-sm text-gray-600">
          <Link href="/forgot-password" className="text-blue-600 hover:underline">
            ¿Olvidaste tu contraseña?
          </Link>
        </p>
      </form>
    </div>
  )
}
```

### 8. `src/features/auth/components/SignupForm.tsx`

```tsx
'use client'

import { useState } from 'react'
import { signup } from '@/actions/auth'
import { GoogleSignInButton } from './GoogleSignInButton'
import { AuthDivider } from './AuthDivider'

export function SignupForm() {
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(formData: FormData) {
    setLoading(true)
    setError(null)

    const result = await signup(formData)

    if (result?.error) {
      setError(result.error)
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <GoogleSignInButton label="Registrarse con Google" />

      <AuthDivider />

      <form action={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="name" className="block text-sm font-medium">
            Nombre completo
          </label>
          <input
            id="name"
            name="name"
            type="text"
            required
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <div>
          <label htmlFor="email" className="block text-sm font-medium">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <div>
          <label htmlFor="password" className="block text-sm font-medium">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            minLength={8}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        {error && (
          <p className="text-sm text-red-600">{error}</p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? 'Creando cuenta...' : 'Create Account'}
        </button>
      </form>
    </div>
  )
}
```

### 9. `src/features/auth/components/ForgotPasswordForm.tsx`

```tsx
'use client'

import { useState } from 'react'
import { resetPassword } from '@/actions/auth'

export function ForgotPasswordForm() {
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(formData: FormData) {
    setLoading(true)
    setError(null)

    const result = await resetPassword(formData)

    if (result?.error) {
      setError(result.error)
      setLoading(false)
    } else {
      setSuccess(true)
      setLoading(false)
    }
  }

  if (success) {
    return (
      <div className="text-center">
        <p className="text-green-600">Revisa tu correo para el enlace de recuperacion.</p>
      </div>
    )
  }

  return (
    <form action={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="email" className="block text-sm font-medium">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      {error && (
        <p className="text-sm text-red-600">{error}</p>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {loading ? 'Enviando...' : 'Enviar enlace de recuperacion'}
      </button>
    </form>
  )
}
```

### 10. `src/features/auth/components/UpdatePasswordForm.tsx`

```tsx
'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { updatePassword } from '@/actions/auth'

export function UpdatePasswordForm() {
  const searchParams = useSearchParams()
  const secret = searchParams.get('secret') || ''
  const userId = searchParams.get('userId') || ''
  
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(formData: FormData) {
    setLoading(true)
    setError(null)

    const result = await updatePassword(formData)

    if (result?.error) {
      setError(result.error)
      setLoading(false)
    }
  }

  return (
    <form action={handleSubmit} className="space-y-4">
      <input type="hidden" name="secret" value={secret} />
      <input type="hidden" name="userId" value={userId} />

      <div>
        <label htmlFor="password" className="block text-sm font-medium">
          Nueva Contraseña
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={8}
          className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      {error && (
        <p className="text-sm text-red-600">{error}</p>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {loading ? 'Actualizando...' : 'Establecer nueva contraseña'}
      </button>
    </form>
  )
}
```

### 11. `src/features/auth/components/GoogleSignInButton.tsx`

```tsx
'use client'

import { useState } from 'react'
import { account } from '@/lib/appwrite/client'
import { OAuthProvider } from 'appwrite'

interface GoogleSignInButtonProps {
  redirectTo?: string
  label?: string
}

export function GoogleSignInButton({
  redirectTo = '/dashboard',
  label = 'Continuar con Google',
}: GoogleSignInButtonProps) {
  const [loading, setLoading] = useState(false)

  function handleGoogleSignIn() {
    setLoading(true)
    try {
      account.createOAuth2Session(
        OAuthProvider.Google,
        `${window.location.origin}${redirectTo}`,
        `${window.location.origin}/login?error=auth_callback_failed`
      )
    } catch (err) {
      console.error('Google sign-in error:', err)
      setLoading(false)
    }
  }

  return (
    <button
      type="button"
      onClick={handleGoogleSignIn}
      disabled={loading}
      className="flex w-full items-center justify-center gap-3 rounded-md border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50 disabled:opacity-50"
    >
      <svg className="h-5 w-5" viewBox="0 0 24 24">
        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
        <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
        <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
      </svg>
      {loading ? 'Redirigiendo...' : label}
    </button>
  )
}
```

### 12. `src/features/auth/components/AuthDivider.tsx`

```tsx
export function AuthDivider() {
  return (
    <div className="relative my-6">
      <div className="absolute inset-0 flex items-center">
        <div className="w-full border-t border-gray-300" />
      </div>
      <div className="relative flex justify-center text-sm">
        <span className="bg-white px-2 text-gray-500">o</span>
      </div>
    </div>
  )
}
```

### 13. `src/features/auth/components/index.ts`

```typescript
export { LoginForm } from './LoginForm'
export { SignupForm } from './SignupForm'
export { GoogleSignInButton } from './GoogleSignInButton'
export { AuthDivider } from './AuthDivider'
export { ForgotPasswordForm } from './ForgotPasswordForm'
export { UpdatePasswordForm } from './UpdatePasswordForm'
```

### 14. `src/app/(auth)/login/page.tsx`

```tsx
import Link from 'next/link'
import { LoginForm } from '@/features/auth/components'

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-md space-y-8 p-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold">Welcome back</h1>
          <p className="mt-2 text-gray-600">Sign in to your account</p>
        </div>

        <LoginForm />

        <p className="text-center text-sm text-gray-600">
          ¿No tienes una cuenta?{' '}
          <Link href="/signup" className="text-blue-600 hover:underline">
            Registrate
          </Link>
        </p>
      </div>
    </div>
  )
}
```

### 15. `src/app/(auth)/signup/page.tsx`

```tsx
import Link from 'next/link'
import { SignupForm } from '@/features/auth/components'

export default function SignupPage() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-md space-y-8 p-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold">Create account</h1>
          <p className="mt-2 text-gray-600">Get started for free</p>
        </div>

        <SignupForm />

        <p className="text-center text-sm text-gray-600">
          ¿Ya tienes una cuenta?{' '}
          <Link href="/login" className="text-blue-600 hover:underline">
            Inicia sesion
          </Link>
        </p>
      </div>
    </div>
  )
}
```

---

## Flujo de Ejecucion

1. Crear TODOS los archivos de codigo listados arriba.
2. Verificar que las dependencias `appwrite` y `node-appwrite` esten instaladas. Si no, ejecutaras la instalacion.
3. **Configuracion de Appwrite Dashboard:**
   - Crear una coleccion llamada `profiles` en la base de datos de Appwrite.
   - Habilitar **documentSecurity: true** (Document-level permissions).
   - Añadir los siguientes atributos a la coleccion:
     - `email` (Type: string, Required: true, Size: 255)
     - `full_name` (Type: string, Required: false, Size: 255)
     - `avatar_url` (Type: string, Required: false, Size: 500)
   - Añadir permisos en la coleccion `profiles`:
     - Rol `any` -> Permiso `create` (para que los nuevos usuarios puedan registrarse).
     - Rol `users` -> Permiso `read` (para que los usuarios autenticados puedan leer perfiles).

---

## Mensaje Final

Despues de crear los archivos e instruir sobre la creacion de la coleccion, muestra:

```
Auth B2B con Appwrite implementado!

Incluye:
- Login/Signup con Email/Password
- Login/Signup con Google OAuth
- Password Reset completo con recuperacion
- Coleccion 'profiles' en Appwrite (mapeada a datos del usuario)
- Hook useAuth() con user + profile en tiempo real
- Proteccion de rutas (/dashboard) via proxy.ts

Configurar credenciales:

1. Ve a cloud.appwrite.io > tu proyecto.
2. Copia estas variables a .env.local:

   NEXT_PUBLIC_APPWRITE_ENDPOINT=https://cloud.appwrite.io/v1
   NEXT_PUBLIC_APPWRITE_PROJECT_ID=tu_project_id
   NEXT_PUBLIC_APPWRITE_DATABASE_ID=tu_database_id
   APPWRITE_API_KEY=tu_api_key_secreta
   NEXT_PUBLIC_SITE_URL=http://localhost:3000

3. En Settings > Platforms:
   - Añade una plataforma Web con Hostname: localhost

4. En Auth > Providers:
   - Habilita Google
   - Sigue la guia para configurar OAuth (Google Cloud Console OAuth Web app con redirect URI proveido por Appwrite)
```
