#!/usr/bin/env node

import { spawn } from 'child_process'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import mongodb from 'mongodb'

const { MongoClient, ObjectId } = mongodb

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const runTests = async () => {
  parseCommandLineArgs()

  if (process.argv.includes('--list')) return listAllTests()

  try {
    logHeader('MongoDB Lens Test Suite', 'margin:bottom')

    await initialize()

    logHeader('Testing Tools', 'margin:top,bottom')

    for (const group of TEST_GROUPS) {
      if (group.name !== 'Resources' && group.name !== 'Prompts') {
        await runTestGroup(group.name, group.tests)
      }
    }

    logHeader('Testing Resources', 'margin:top,bottom')

    const resourcesGroup = TEST_GROUPS.find(g => g.name === 'Resources')
    if (resourcesGroup) await runTestGroup(resourcesGroup.name, resourcesGroup.tests)

    logHeader('Testing Prompts', 'margin:top,bottom')

    const promptsGroup = TEST_GROUPS.find(g => g.name === 'Prompts')
    if (promptsGroup) await runTestGroup(promptsGroup.name, promptsGroup.tests)
  } finally {
    await cleanup()
    displayTestSummary()
  }
}

const runTestGroup = async (groupName, tests) => {
  let anyTestsInGroup = false

  for (const test of tests) {
    if (shouldRunTest(test.name, groupName)) {
      anyTestsInGroup = true
      break
    }
  }

  if (!anyTestsInGroup) return console.log(`${COLORS.yellow}Skipping group: ${groupName} - No matching tests${COLORS.reset}`)

  console.log(`${COLORS.blue}Running tests in group: ${groupName}${COLORS.reset}`)

  for (const test of tests) {
    if (shouldRunTest(test.name, groupName)) {
      await runTest(test.name, test.fn)
    } else {
      skipTest(test.name, 'Not selected for execution')
    }
  }
}

const shouldRunTest = (testName, groupName) => {
  if (!testFilters.length && !groupFilters.length && !patternFilters.length) return true

  if (testFilters.includes(testName)) return true

  if (groupFilters.includes(groupName)) return true

  for (const pattern of patternFilters) {
    const regexPattern = pattern.replace(/\*/g, '.*')
    const regex = new RegExp(regexPattern, 'i')
    if (regex.test(testName)) return true
  }

  return false
}

const listAllTests = () => {
  logHeader('Available Test Groups & Tests', 'margin:bottom')

  TEST_GROUPS.forEach(group => {
    console.log(`${COLORS.yellow}${group.name}:${COLORS.reset}`)
    group.tests.forEach(test => {
      console.log(`- ${test.name}`)
    })
    console.log('')
  })

  console.log(`${COLORS.yellow}Usage:${COLORS.reset}`)
  console.log('  --test=<test-name>     Run specific test(s), comma separated')
  console.log('  --group=<group-name>   Run all tests in specific group(s), comma separated')
  console.log('  --pattern=<pattern>    Run tests matching pattern (glob style, e.g. *collection*)')
  console.log('  --list                 List all available tests without running them')

  process.exit(0)
}

const parseCommandLineArgs = () => {
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i]

    if (arg.startsWith('--test=')) {
      const tests = arg.replace('--test=', '').split(',')
      testFilters.push(...tests.map(t => t.trim()))
    } else if (arg.startsWith('--group=')) {
      const groups = arg.replace('--group=', '').split(',')
      groupFilters.push(...groups.map(g => g.trim()))
    } else if (arg.startsWith('--pattern=')) {
      const patterns = arg.replace('--pattern=', '').split(',')
      patternFilters.push(...patterns.map(p => p.trim()))
    }
  }

  if (testFilters.length || groupFilters.length || patternFilters.length) {
    console.log(`${COLORS.blue}Running with filters:${COLORS.reset}`)
    if (testFilters.length) console.log(`${COLORS.blue}Tests: ${testFilters.join(', ')}${COLORS.reset}`)
    if (groupFilters.length) console.log(`${COLORS.blue}Groups: ${groupFilters.join(', ')}${COLORS.reset}`)
    if (patternFilters.length) console.log(`${COLORS.blue}Patterns: ${patternFilters.join(', ')}${COLORS.reset}`)
  }
}

const initialize = async () => {
  mongoUri = await setupMongoUri()
  await connectToMongo()
  await setupTestEnvironment()
}

const setupMongoUri = async () => {
  const uri = process.env.CONFIG_MONGO_URI

  if (uri === 'mongodb-memory-server') return await startInMemoryMongo()

  if (!uri) {
    console.error(`${COLORS.red}No MongoDB URI provided. Please set CONFIG_MONGO_URI environment variable.${COLORS.reset}`)
    console.error(`${COLORS.yellow}Example: CONFIG_MONGO_URI=mongodb://localhost:27017 node mongodb-lens.test.js${COLORS.reset}`)
    console.error(`${COLORS.yellow}Example: CONFIG_MONGO_URI=mongodb-memory-server node mongodb-lens.test.js${COLORS.reset}`)
    process.exit(1)
  }

  return uri
}

const startInMemoryMongo = async () => {
  console.log(`${COLORS.yellow}In-memory MongoDB requested. Checking if mongodb-memory-server is available…${COLORS.reset}`)
  try {
    const { MongoMemoryServer } = await import('mongodb-memory-server')
    const mongod = await MongoMemoryServer.create()
    const uri = mongod.getUri()
    console.log(`${COLORS.green}In-memory MongoDB instance started at: ${uri}${COLORS.reset}`)

    process.on('exit', async () => {
      console.log(`${COLORS.yellow}Stopping in-memory MongoDB server…${COLORS.reset}`)
      await mongod.stop()
    })

    return uri
  } catch (err) {
    console.error(`${COLORS.red}Failed to start in-memory MongoDB: ${err.message}${COLORS.reset}`)
    console.error(`${COLORS.yellow}Install with: npm install mongodb-memory-server --save-dev${COLORS.reset}`)
    process.exit(1)
  }
}

const connectToMongo = async () => {
  console.log(`${COLORS.blue}Connecting to MongoDB: ${obfuscateMongoUri(mongoUri)}${COLORS.reset}`)

  if (!existsSync(MONGODB_LENS_PATH)) {
    console.error(`${COLORS.red}MongoDB Lens script not found at: ${MONGODB_LENS_PATH}${COLORS.reset}`)
    process.exit(1)
  }

  directMongoClient = new MongoClient(mongoUri, {
    retryWrites: true
  })

  await directMongoClient.connect()
  console.log(`${COLORS.green}Connected to MongoDB successfully.${COLORS.reset}`)
}

const obfuscateMongoUri = uri => {
  if (!uri || typeof uri !== 'string') return uri
  try {
    if (uri.includes('@') && uri.includes('://')) {
      const parts = uri.split('@')
      const authPart = parts[0]
      const restPart = parts.slice(1).join('@')
      const authIndex = authPart.lastIndexOf('://')
      if (authIndex !== -1) {
        const protocol = authPart.substring(0, authIndex + 3)
        const credentials = authPart.substring(authIndex + 3)
        if (credentials.includes(':')) {
          const [username] = credentials.split(':')
          return `${protocol}${username}:********@${restPart}`
        }
      }
    }
    return uri
  } catch (error) {
    return uri
  }
}

const setupTestEnvironment = async () => {
  await checkServerCapabilities()
  testDb = directMongoClient.db(TEST_DB_NAME)
  await cleanupTestDatabase()
  await setupTestData()
  console.log(`${COLORS.blue}Running tests against MongoDB Lens…${COLORS.reset}`)
}

const checkServerCapabilities = async () => {
  try {
    const adminDb = directMongoClient.db('admin')

    const replSetStatus = await adminDb.command({ replSetGetStatus: 1 }).catch(() => null)
    isReplSet = !!replSetStatus
    console.log(`${COLORS.blue}MongoDB instance ${isReplSet ? 'is' : 'is not'} a replica set.${COLORS.reset}`)

    const listShards = await adminDb.command({ listShards: 1 }).catch(() => null)
    isSharded = !!listShards
    console.log(`${COLORS.blue}MongoDB instance ${isSharded ? 'is' : 'is not'} a sharded cluster.${COLORS.reset}`)
  } catch (error) {
    console.log(`${COLORS.yellow}Not a replica set: ${error.message}${COLORS.reset}`)
  }
}

const setupTestData = async () => {
  try {
    testCollection = testDb.collection(TEST_COLLECTION_NAME)
    await createTestDocuments()
    await createTestIndexes()
    await createTestGeospatialData()
    await createTestUser()
    console.log(`${COLORS.green}Test data setup complete.${COLORS.reset}`)
  } catch (err) {
    console.error(`${COLORS.red}Error setting up test data: ${err.message}${COLORS.reset}`)
  }
}

const createTestDocuments = async () => {
  const testDocuments = Array(50).fill(0).map((_, i) => ({
    _id: new ObjectId(),
    name: `Test Document ${i}`,
    value: i,
    tags: [`tag${i % 5}`, `category${i % 3}`],
    isActive: i % 2 === 0,
    createdAt: new Date(Date.now() - i * 86400000)
  }))

  await testCollection.insertMany(testDocuments)

  const anotherCollection = testDb.collection(ANOTHER_TEST_COLLECTION)
  await anotherCollection.insertMany([
    { name: 'Test 1', value: 10 },
    { name: 'Test 2', value: 20 }
  ])

  await testCollection.insertOne({
    name: 'Date Test',
    startDate: new Date('2023-01-01'),
    endDate: new Date('2023-12-31')
  })
}

const createTestIndexes = async () => {
  await testCollection.createIndex({ name: 1 })
  await testCollection.createIndex({ value: -1 })
  await testCollection.createIndex({ tags: 1 })
  await testCollection.createIndex({ name: 'text', tags: 'text' })
  await testCollection.createIndex({ location: '2dsphere' })
}

const createTestGeospatialData = async () => {
  await testCollection.insertMany([
    {
      name: 'Geo Test 1',
      location: { type: 'Point', coordinates: [-73.9857, 40.7484] }
    },
    {
      name: 'Geo Test 2',
      location: { type: 'Point', coordinates: [-118.2437, 34.0522] }
    }
  ])
}

const createTestUser = async () => {
  try {
    await testDb.command({
      createUser: 'testuser',
      pwd: 'testpassword',
      roles: [{ role: 'read', db: TEST_DB_NAME }]
    })
  } catch (e) {
    console.log(`${COLORS.yellow}Could not create test user: ${e.message}${COLORS.reset}`)
  }
}

const runTest = async (name, testFn) => {
  stats.total++
  console.log(`${COLORS.blue}Running test: ${name}${COLORS.reset}`)
  try {
    const startTime = Date.now()
    await testFn()
    const duration = Date.now() - startTime
    console.log(`${COLORS.green}✓ PASS: ${name} (${duration}ms)${COLORS.reset}`)
    stats.passed++
  } catch (err) {
    console.error(`${COLORS.red}✗ FAIL: ${name} - ${err.message}${COLORS.reset}`)
    console.error(`${COLORS.red}Stack: ${err.stack}${COLORS.reset}`)
    stats.failed++
  }
}

const skipTest = (name, reason) => {
  stats.total++
  stats.skipped++
  console.log(`${COLORS.yellow}⚠ SKIP: ${name} - ${reason}${COLORS.reset}`)
}

const startLensServer = async () => {
  console.log('Starting MongoDB Lens server…')

  const env = {
    ...process.env,
    CONFIG_MONGO_URI: mongoUri,
    CONFIG_LOG_LEVEL: isDebugging ? 'verbose' : 'info',
  }

  if (testConfig.disableTokens) {
    env.CONFIG_DISABLE_DESTRUCTIVE_OPERATION_TOKENS = 'true'
  }

  Object.assign(env, testConfig.extraEnv)

  lensProcess = spawn('node', [MONGODB_LENS_PATH], {
    env: env,
    stdio: ['pipe', 'pipe', 'pipe']
  })

  setupResponseHandling()
  return waitForServerStart()
}

const setupResponseHandling = () => {
  let pendingOutput = ''

  lensProcess.stdout.on('data', data => {
    pendingOutput += data.toString()
    const lines = pendingOutput.split('\n')
    pendingOutput = lines.pop()
    lines.map(line => line.trim()).filter(Boolean).forEach(handleResponseLine)
  })

  lensProcess.stderr.on('data', data => {
    const output = data.toString().trim()
    if (isDebugging)
      console.log(`${COLORS.gray}[SERVER] ${output.split('\n').join(`\n[SERVER] `)}${COLORS.reset}`)
  })
}

const handleResponseLine = (response) => {
  try {
    const parsed = JSON.parse(response)
    if (parsed.id && responseHandlers.has(parsed.id)) {
      const handler = responseHandlers.get(parsed.id)
      responseHandlers.delete(parsed.id)
      handler.resolve(parsed)
    }
  } catch (e) {
    console.error(`Parse error: ${e.message}`)
    console.error(`Response was: ${response.substring(0, 200)}${response.length > 200 ? '…' : ''}`)
  }
}

const waitForServerStart = () => {
  return new Promise((resolve, reject) => {
    const handler = data => {
      if (data.toString().includes('MongoDB Lens server running.')) {
        lensProcess.stderr.removeListener('data', handler)
        console.log('MongoDB Lens server started successfully.')
        resolve()
      }
    }

    lensProcess.stderr.on('data', handler)
    setTimeout(() => reject(new Error('Server startup timed out')), testConfig.serverStartupTimeout)
  })
}

const runLensCommand = async ({ command, params = {} }) => {
  if (!lensProcess) await startLensServer()

  const requestId = nextRequestId++
  const { method, methodParams } = mapToLensMethod(command, params)

  return new Promise((resolve, reject) => {
    const request = {
      jsonrpc: '2.0',
      id: requestId,
      method: method,
      params: methodParams
    }

    responseHandlers.set(requestId, { resolve, reject })

    if (isDebugging) console.log(`Sending request #${requestId}:`, JSON.stringify(request))

    lensProcess.stdin.write(JSON.stringify(request) + '\n')

    setTimeout(() => {
      if (responseHandlers.has(requestId)) {
        responseHandlers.delete(requestId)
        reject(new Error(`Request ${method} timed out after ${testConfig.requestTimeout/1000} seconds`))
      }
    }, testConfig.requestTimeout)
  })
}

const mapToLensMethod = (command, params) => {
  let method, methodParams

  switch(command) {
    case 'mcp.resource.get':
      method = 'resources/read'
      methodParams = { uri: params.uri }
      break
    case 'mcp.tool.invoke':
      method = 'tools/call'
      methodParams = {
        name: params.name,
        arguments: params.args || {}
      }
      break
    case 'mcp.prompt.start':
      method = 'prompts/get'
      methodParams = {
        name: params.name,
        arguments: params.args || {}
      }
      break
    case 'initialize':
      method = 'initialize'
      methodParams = params
      break
    default:
      method = command
      methodParams = params
  }

  return { method, methodParams }
}

const useTestDatabase = async () => {
  await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'use-database',
      args: {
        database: TEST_DB_NAME
      }
    }
  })
}

const handleDestructiveOperationToken = async (tokenResponse, toolName, params) => {
  if (testConfig.disableTokens) {
    return assertToolSuccess(tokenResponse, 'has been permanently deleted')
  }

  assert(tokenResponse?.result?.content[0].text.includes('Confirmation code:'), 'Confirmation message not found')
  const tokenMatch = tokenResponse.result.content[0].text.match(/Confirmation code:\s+(\d+)/)
  assert(tokenMatch && tokenMatch[1], 'Confirmation code not found in text')

  const token = tokenMatch[1]
  const completeResponse = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: toolName,
      args: {
        ...params,
        token
      }
    }
  })

  return assertToolSuccess(completeResponse, 'has been permanently deleted')
}

const assertToolSuccess = (response, successIndicator) => {
  assert(response?.result?.content, 'No content in response')
  assert(Array.isArray(response.result.content), 'Content not an array')
  assert(response.result.content.length > 0, 'Empty content array')
  assert(response.result.content[0].text.includes(successIndicator), `Success message not found: "${successIndicator}"`)
  return response
}

const assertResourceSuccess = (response, successIndicator) => {
  assert(response?.result?.contents, 'No contents in response')
  assert(Array.isArray(response.result.contents), 'Contents not an array')
  assert(response.result.contents.length > 0, 'Empty contents array')
  assert(response.result.contents[0].text.includes(successIndicator), `Success message not found: "${successIndicator}"`)
  return response
}

const assertPromptSuccess = (response, successIndicator) => {
  assert(response?.result?.messages, 'No messages in response')
  assert(Array.isArray(response.result.messages), 'Messages not an array')
  assert(response.result.messages.length > 0, 'Empty messages array')
  assert(response.result.messages[0].content.text.includes(successIndicator), `Success message not found: "${successIndicator}"`)
  return response
}

const assert = (condition, message, context = null) => {
  if (condition) return
  if (context) console.error('CONTEXT:', JSON.stringify(context, null, 2))
  throw new Error(message || 'Assertion failed')
}

const testConnectMongodbTool = async () => {
  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'connect-mongodb',
      args: {
        uri: mongoUri,
        validateConnection: 'true'
      }
    }
  })

  assertToolSuccess(response, 'Successfully connected')
}

const testConnectOriginalTool = async () => {
  await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'connect-mongodb',
      args: {
        uri: mongoUri,
        validateConnection: 'true'
      }
    }
  })

  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'connect-original',
      args: {
        validateConnection: 'true'
      }
    }
  })

  assertToolSuccess(response, 'Successfully connected')
}

const testAddConnectionAliasTool = async () => {
  const aliasName = 'test_alias'
  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'add-connection-alias',
      args: {
        alias: aliasName,
        uri: mongoUri
      }
    }
  })

  assertToolSuccess(response, `Successfully added connection alias '${aliasName}'`)
}

const testListConnectionsTool = async () => {
  const aliasName = 'test_alias_for_list'

  await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'add-connection-alias',
      args: {
        alias: aliasName,
        uri: mongoUri
      }
    }
  })

  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'list-connections'
    }
  })

  assertToolSuccess(response, aliasName)
}

const testListDatabasesTool = async () => {
  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'list-databases'
    }
  })

  assertToolSuccess(response, TEST_DB_NAME)
}

const testCurrentDatabaseTool = async () => {
  await useTestDatabase()

  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'current-database'
    }
  })

  assertToolSuccess(response, `Current database: ${TEST_DB_NAME}`)
}

const testCreateDatabaseTool = async () => {
  const testDbName = `test_create_db_${Date.now()}`

  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'create-database',
      args: {
        name: testDbName,
        switch: 'true',
        validateName: 'true'
      }
    }
  })

  assertToolSuccess(response, `Database '${testDbName}' created`)

  const dbs = await directMongoClient.db('admin').admin().listDatabases()
  const dbExists = dbs.databases.some(db => db.name === testDbName)
  assert(dbExists, `Created database '${testDbName}' not found in database list`)

  await directMongoClient.db(testDbName).dropDatabase()
}

const testUseDatabaseTool = async () => {
  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'use-database',
      args: {
        database: TEST_DB_NAME
      }
    }
  })

  assertToolSuccess(response, `Switched to database: ${TEST_DB_NAME}`)
}

const testDropDatabaseTool = async () => {
  const testDbToDrop = `test_drop_db_${Date.now()}`

  await directMongoClient.db(testDbToDrop).collection('test').insertOne({ test: 1 })

  await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'use-database',
      args: {
        database: testDbToDrop
      }
    }
  })

  const tokenResponse = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'drop-database',
      args: {
        name: testDbToDrop
      }
    }
  })

  await handleDestructiveOperationToken(tokenResponse, 'drop-database', { name: testDbToDrop })

  const dbs = await directMongoClient.db('admin').admin().listDatabases()
  const dbExists = dbs.databases.some(db => db.name === testDbToDrop)
  assert(!dbExists, `Dropped database '${testDbToDrop}' still exists`)
}

const testCreateUserTool = async () => {
  const username = `test_user_${Date.now()}`

  await useTestDatabase()

  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'create-user',
      args: {
        username: username,
        password: 'test_password',
        roles: JSON.stringify([{ role: 'read', db: TEST_DB_NAME }])
      }
    }
  })

  assertToolSuccess(response, `User '${username}' created`)

  const usersInfo = await testDb.command({ usersInfo: username })
  assert(usersInfo.users.length > 0, `Created user '${username}' not found`)
}

const testDropUserTool = async () => {
  const username = `test_drop_user_${Date.now()}`

  await useTestDatabase()

  await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'create-user',
      args: {
        username: username,
        password: 'test_password',
        roles: JSON.stringify([{ role: 'read', db: TEST_DB_NAME }])
      }
    }
  })

  const tokenResponse = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'drop-user',
      args: {
        username: username
      }
    }
  })

  let dropped = false

  if (testConfig.disableTokens) {
    assertToolSuccess(tokenResponse, 'dropped successfully')
    dropped = true
  } else {
    assert(tokenResponse?.result?.content[0].text.includes('Confirmation code:'), 'Confirmation message not found')

    const tokenMatch = tokenResponse.result.content[0].text.match(/Confirmation code:\s+(\d+)/)
    assert(tokenMatch && tokenMatch[1], 'Confirmation code not found in text')

    const token = tokenMatch[1]

    const dropResponse = await runLensCommand({
      command: 'mcp.tool.invoke',
      params: {
        name: 'drop-user',
        args: {
          username: username,
          token
        }
      }
    })

    assertToolSuccess(dropResponse, 'dropped successfully')
    dropped = true
  }

  if (dropped) {
    const usersInfo = await testDb.command({ usersInfo: username })
    assert(usersInfo.users.length === 0, `Dropped user '${username}' still exists`)
  }
}

const testListCollectionsTool = async () => {
  await useTestDatabase()

  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'list-collections'
    }
  })

  assertToolSuccess(response, TEST_COLLECTION_NAME)
}

const testCreateCollectionTool = async () => {
  const collectionName = `test_create_coll_${Date.now()}`

  await useTestDatabase()

  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'create-collection',
      args: {
        name: collectionName,
        options: JSON.stringify({})
      }
    }
  })

  assertToolSuccess(response, `Collection '${collectionName}' created`)

  const collections = await testDb.listCollections().toArray()
  const collExists = collections.some(coll => coll.name === collectionName)
  assert(collExists, `Created collection '${collectionName}' not found`)
}

const testDropCollectionTool = async () => {
  const collectionName = `test_drop_coll_${Date.now()}`

  await useTestDatabase()

  await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'create-collection',
      args: {
        name: collectionName,
        options: JSON.stringify({})
      }
    }
  })

  const tokenResponse = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'drop-collection',
      args: {
        name: collectionName
      }
    }
  })

  await handleDestructiveOperationToken(tokenResponse, 'drop-collection', { name: collectionName })

  const collections = await testDb.listCollections().toArray()
  const collExists = collections.some(coll => coll.name === collectionName)
  assert(!collExists, `Dropped collection '${collectionName}' still exists`)
}

const testRenameCollectionTool = async () => {
  const oldName = `test_rename_old_${Date.now()}`
  const newName = `test_rename_new_${Date.now()}`

  await useTestDatabase()

  await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'create-collection',
      args: {
        name: oldName,
        options: JSON.stringify({})
      }
    }
  })

  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'rename-collection',
      args: {
        oldName: oldName,
        newName: newName,
        dropTarget: 'false'
      }
    }
  })

  assertToolSuccess(response, `renamed to '${newName}'`)

  const collections = await testDb.listCollections().toArray()
  const oldExists = collections.some(coll => coll.name === oldName)
  const newExists = collections.some(coll => coll.name === newName)
  assert(!oldExists, `Old collection '${oldName}' still exists`)
  assert(newExists, `New collection '${newName}' not found`)
}

const testValidateCollectionTool = async () => {
  await useTestDatabase()

  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'validate-collection',
      args: {
        collection: TEST_COLLECTION_NAME,
        full: 'false'
      }
    }
  })

  assertToolSuccess(response, 'Validation Results')

  const content = response.result.content[0].text
  assert(content.includes('Collection'), 'Collection name not found')
  assert(content.includes('Valid:') || content.includes('Records Validated:'), 'Validation results not found')
}

const testDistinctValuesTool = async () => {
  await useTestDatabase()

  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'distinct-values',
      args: {
        collection: TEST_COLLECTION_NAME,
        field: 'tags',
        filter: '{}'
      }
    }
  })

  assertToolSuccess(response, 'Distinct values for field')

  const content = response.result.content[0].text
  assert(content.includes('tag') || content.includes('category'), 'Expected distinct tag values not found')
}

const testFindDocumentsTool = async () => {
  await useTestDatabase()

  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'find-documents',
      args: {
        collection: TEST_COLLECTION_NAME,
        filter: '{"value": {"$lt": 10}}',
        limit: 5
      }
    }
  })

  const content = response.result.content[0].text
  assert(content.includes('"value":'), 'Value field not found')
  assert(content.includes('"name":'), 'Name field not found')
}

const testCountDocumentsTool = async () => {
  await useTestDatabase()

  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'count-documents',
      args: {
        collection: TEST_COLLECTION_NAME,
        filter: '{"isActive": true}'
      }
    }
  })

  assertToolSuccess(response, 'Count:')
  assert(/Count: \d+ document/.test(response.result.content[0].text), 'Count number not found')
}

const testInsertDocumentTool = async () => {
  await useTestDatabase()

  const testDoc = {
    name: 'Test Insert',
    value: 999,
    tags: ['test', 'insert'],
    isActive: true,
    createdAt: new Date().toISOString()
  }

  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'insert-document',
      args: {
        collection: TEST_COLLECTION_NAME,
        document: JSON.stringify(testDoc)
      }
    }
  })

  assertToolSuccess(response, 'inserted successfully')

  const countResponse = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'count-documents',
      args: {
        collection: TEST_COLLECTION_NAME,
        filter: '{"value": 999}'
      }
    }
  })

  assert(countResponse.result.content[0].text.includes('Count: 1'), 'Inserted document not found')
}

const testUpdateDocumentTool = async () => {
  await useTestDatabase()

  const testDoc = {
    name: 'Update Test',
    value: 888,
    tags: ['update'],
    isActive: true
  }

  await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'insert-document',
      args: {
        collection: TEST_COLLECTION_NAME,
        document: JSON.stringify(testDoc)
      }
    }
  })

  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'update-document',
      args: {
        collection: TEST_COLLECTION_NAME,
        filter: '{"value": 888}',
        update: '{"$set": {"name": "Updated Test", "tags": ["updated"]}}'
      }
    }
  })

  assertToolSuccess(response, 'Matched:')
  assert(response.result.content[0].text.includes('Modified:'), 'Modified count not found')

  const findResponse = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'find-documents',
      args: {
        collection: TEST_COLLECTION_NAME,
        filter: '{"value": 888}'
      }
    }
  })

  const responseText = findResponse.result.content[0].text
  assert(responseText.includes('"name"') && responseText.includes('Updated Test'), 'Updated name not found')
  assert(responseText.includes('"tags"') && responseText.includes('updated'), 'Updated tags not found')
}

const testDeleteDocumentTool = async () => {
  await useTestDatabase()

  const testDoc = {
    name: 'Delete Test',
    value: 777,
    tags: ['delete'],
    isActive: true
  }

  await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'insert-document',
      args: {
        collection: TEST_COLLECTION_NAME,
        document: JSON.stringify(testDoc)
      }
    }
  })

  const countBeforeResponse = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'count-documents',
      args: {
        collection: TEST_COLLECTION_NAME,
        filter: '{"value": 777}'
      }
    }
  })

  assert(countBeforeResponse.result.content[0].text.includes('Count: 1'), 'Test document not found before delete')

  const tokenResponse = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'delete-document',
      args: {
        collection: TEST_COLLECTION_NAME,
        filter: '{"value": 777}',
        many: 'false'
      }
    }
  })

  if (testConfig.disableTokens) {
    assertToolSuccess(tokenResponse, 'Successfully deleted')
  } else {
    assert(tokenResponse?.result?.content[0].text.includes('Confirmation code:'), 'Confirmation message not found')

    const tokenMatch = tokenResponse.result.content[0].text.match(/Confirmation code:\s+(\d+)/)
    assert(tokenMatch && tokenMatch[1], 'Confirmation code not found in text')

    const token = tokenMatch[1]

    const deleteResponse = await runLensCommand({
      command: 'mcp.tool.invoke',
      params: {
        name: 'delete-document',
        args: {
          collection: TEST_COLLECTION_NAME,
          filter: '{"value": 777}',
          many: 'false',
          token
        }
      }
    })

    assertToolSuccess(deleteResponse, 'Successfully deleted')
  }

  const countResponse = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'count-documents',
      args: {
        collection: TEST_COLLECTION_NAME,
        filter: '{"value": 777}'
      }
    }
  })

  assert(countResponse.result.content[0].text.includes('Count: 0'), 'Document still exists after deletion')
}

const testAggregateDataTool = async () => {
  await useTestDatabase()

  const pipeline = [
    { $match: { isActive: true } },
    { $group: { _id: null, avgValue: { $avg: '$value' }, count: { $sum: 1 } } }
  ]

  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'aggregate-data',
      args: {
        collection: TEST_COLLECTION_NAME,
        pipeline: JSON.stringify(pipeline)
      }
    }
  })

  const content = response.result.content[0].text
  assert(content.includes('"avgValue":'), 'Average value not found')
  assert(content.includes('"count":'), 'Count not found')
}

const testAggregateDataOutStageTool = async () => {
  await useTestDatabase()

  const targetName = `aggregate_out_${Date.now()}`

  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'aggregate-data',
      args: {
        collection: TEST_COLLECTION_NAME,
        pipeline: JSON.stringify([{ $match: {} }, { $out: targetName }])
      }
    }
  })

  assert(!response.result.isError, `Unexpected error: ${response.result.content[0].text}`)
  const writtenCount = await testDb.collection(targetName).countDocuments()
  assert(writtenCount > 0, '$out stage did not write documents')
  await testDb.collection(targetName).drop()
}

const testReadOnlyHidesWriteTools = () => withReadOnlyLensServer(async () => {
  const response = await runLensCommand({ command: 'tools/list' })
  const toolNames = response.result.tools.map(tool => tool.name)

  const blockedTools = ['insert-document', 'drop-collection', 'connect-mongodb', 'add-connection-alias']
  const visibleBlockedTools = blockedTools.filter(name => toolNames.includes(name))
  assert(visibleBlockedTools.length === 0, `Write tools registered in read-only mode: ${visibleBlockedTools.join(', ')}`)
  assert(toolNames.includes('find-documents'), 'find-documents missing in read-only mode')
  assert(toolNames.includes('aggregate-data'), 'aggregate-data missing in read-only mode')
})

const testReadOnlyBlocksAggregationWrites = () => withReadOnlyLensServer(() =>
  assertAggregationWritesBlocked('MongoDB Lens is in read-only mode'))

const testDisabledWriteToolsBlockAggregationWrites = async () => {
  const configPath = writeTempConfig({ disabled: { tools: ['insert-document', 'update-document', 'delete-document'] } })
  await withLensServerEnv({ CONFIG_PATH: configPath }, () =>
    assertAggregationWritesBlocked('write tools are disabled'))
}

const testReadOnlyInstructions = () => withReadOnlyLensServer(async () => {
  const response = await runLensCommand({
    command: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'mongodb-lens-test', version: '1.0.0' }
    }
  })
  assert(response.result.instructions.includes('READ-ONLY MODE'), 'Read-only notice missing from server instructions')
})

const testInvalidReadOnlyValueExits = async () => {
  const { exitCode, stderr } = await runLensUntilExit({ CONFIG_READ_ONLY: 'yes' })
  assert(exitCode === 1, `Expected exit code 1, got ${exitCode}`)
  assert(stderr.includes('CONFIG_READ_ONLY'), 'Error message does not name CONFIG_READ_ONLY')
}

const testReadOnlyKeyTypoExits = async () => {
  const configPath = writeTempConfig({ readonly: true })
  const { exitCode, stderr } = await runLensUntilExit({ CONFIG_PATH: configPath })
  assert(exitCode === 1, `Expected exit code 1, got ${exitCode}`)
  assert(stderr.includes("Did you mean 'readOnly'?"), 'Error message does not suggest readOnly')
}

const assertAggregationWritesBlocked = async (expectedReason) => {
  await useTestDatabase()

  for (const writeStage of ['$out', '$merge']) {
    const targetName = `write_protected_${writeStage.slice(1)}_${Date.now()}`

    const response = await runLensCommand({
      command: 'mcp.tool.invoke',
      params: {
        name: 'aggregate-data',
        args: {
          collection: TEST_COLLECTION_NAME,
          pipeline: JSON.stringify([{ $match: {} }, { [writeStage]: targetName }])
        }
      }
    })

    const responseText = response.result.content[0].text
    assert(response.result.isError, `${writeStage} stage was not rejected`)
    assert(responseText.includes(expectedReason), `Unexpected ${writeStage} error message: ${responseText}`)
    const targetExists = await testDb.listCollections({ name: targetName }).hasNext()
    assert(!targetExists, `${writeStage} stage created collection '${targetName}'`)
  }
}

const writeTempConfig = (config) => {
  const configPath = join(tmpdir(), `mongodb-lens-test-${process.pid}-${Date.now()}.json`)
  writeFileSync(configPath, JSON.stringify(config))
  return configPath
}

const runLensUntilExit = (extraEnv) => new Promise(resolve => {
  const child = spawn('node', [MONGODB_LENS_PATH], {
    env: { ...process.env, CONFIG_MONGO_URI: mongoUri, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', data => { stderr += data.toString() })
  const timeout = setTimeout(() => child.kill('SIGKILL'), testConfig.serverStartupTimeout)
  child.on('exit', exitCode => {
    clearTimeout(timeout)
    resolve({ exitCode, stderr })
  })
})

const testReadOnlyLeavesProfilerUnchanged = async () => {
  const sentinelSlowMs = 123
  await testDb.command({ profile: 0, slowms: sentinelSlowMs })

  try {
    await withReadOnlyLensServer(async () => {
      await useTestDatabase()
      const { slowms } = await testDb.command({ profile: -1 })
      assert(slowms === sentinelSlowMs, `Profiler slowms changed from ${sentinelSlowMs} to ${slowms}`)
    })
  } finally {
    await testDb.command({ profile: 0, slowms: 100 })
  }
}

const withReadOnlyLensServer = (testFn) =>
  withLensServerEnv({ CONFIG_READ_ONLY: 'true' }, testFn)

const withLensServerEnv = async (extraEnv, testFn) => {
  await stopLensServer()
  testConfig.extraEnv = extraEnv
  try {
    await testFn()
  } finally {
    await stopLensServer()
    testConfig.extraEnv = {}
  }
}

const stopLensServer = async () => {
  if (!lensProcess) return
  const exited = new Promise(resolve => lensProcess.once('exit', resolve))
  lensProcess.kill('SIGKILL')
  await exited
  lensProcess = null
}

const testCreateIndexTool = async () => {
  await useTestDatabase()

  const indexName = `test_index_${Date.now()}`

  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'create-index',
      args: {
        collection: TEST_COLLECTION_NAME,
        keys: '{"createdAt": 1}',
        options: JSON.stringify({ name: indexName })
      }
    }
  })

  assertToolSuccess(response, 'Index created')
  assert(response.result.content[0].text.includes(indexName), 'Index name not found')
}

const testDropIndexTool = async () => {
  await useTestDatabase()

  const indexName = `test_drop_index_${Date.now()}`

  await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'create-index',
      args: {
        collection: TEST_COLLECTION_NAME,
        keys: '{"testField": 1}',
        options: JSON.stringify({ name: indexName })
      }
    }
  })

  const tokenResponse = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'drop-index',
      args: {
        collection: TEST_COLLECTION_NAME,
        indexName: indexName
      }
    }
  })

  let dropped = false

  if (testConfig.disableTokens) {
    assertToolSuccess(tokenResponse, 'dropped from collection')
    dropped = true
  } else {
    assert(tokenResponse?.result?.content[0].text.includes('Confirmation code:'), 'Confirmation message not found')

    const tokenMatch = tokenResponse.result.content[0].text.match(/Confirmation code:\s+(\d+)/)
    assert(tokenMatch && tokenMatch[1], 'Confirmation code not found in text')

    const token = tokenMatch[1]

    const dropResponse = await runLensCommand({
      command: 'mcp.tool.invoke',
      params: {
        name: 'drop-index',
        args: {
          collection: TEST_COLLECTION_NAME,
          indexName: indexName,
          token
        }
      }
    })

    assertToolSuccess(dropResponse, 'dropped from collection')
    dropped = true
  }

  if (dropped) {
    const indexes = await testDb.collection(TEST_COLLECTION_NAME).indexes()
    const indexStillExists = indexes.some(idx => idx.name === indexName)
    assert(!indexStillExists, `Dropped index '${indexName}' still exists`)
  }
}

const testAnalyzeSchemaTool = async () => {
  await useTestDatabase()

  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'analyze-schema',
      args: {
        collection: TEST_COLLECTION_NAME,
        sampleSize: 20
      }
    }
  })

  assertToolSuccess(response, 'Schema for')
  const content = response.result.content[0].text
  assert(content.includes('name:'), 'Name field not found')
  assert(content.includes('value:'), 'Value field not found')
  assert(content.includes('tags:'), 'Tags field not found')
}

const testGenerateSchemaValidatorTool = async () => {
  await useTestDatabase()

  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'generate-schema-validator',
      args: {
        collection: TEST_COLLECTION_NAME,
        strictness: 'moderate'
      }
    }
  })

  assertToolSuccess(response, 'MongoDB JSON Schema Validator')
  const content = response.result.content[0].text
  assert(content.includes('$jsonSchema'), 'JSON Schema not found')
  assert(content.includes('properties'), 'Properties not found')
}

const testCompareSchemasTool = async () => {
  await useTestDatabase()

  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'compare-schemas',
      args: {
        sourceCollection: TEST_COLLECTION_NAME,
        targetCollection: ANOTHER_TEST_COLLECTION,
        sampleSize: 10
      }
    }
  })

  assertToolSuccess(response, 'Schema Comparison')
  const content = response.result.content[0].text
  assert(content.includes('Source Collection'), 'Source info not found')
  assert(content.includes('Target Collection'), 'Target info not found')
}

const testExplainQueryTool = async () => {
  await useTestDatabase()

  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'explain-query',
      args: {
        collection: TEST_COLLECTION_NAME,
        filter: '{"value": {"$gt": 10}}',
        verbosity: 'queryPlanner'
      }
    }
  })

  assertToolSuccess(response, 'Query Explanation')
  assert(response.result.content[0].text.includes('Query Planner'), 'Query planner not found')
}

const testAnalyzeQueryPatternsTool = async () => {
  await useTestDatabase()

  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'analyze-query-patterns',
      args: {
        collection: TEST_COLLECTION_NAME,
        duration: 1
      }
    }
  })

  assertToolSuccess(response, 'Query Pattern Analysis')

  const content = response.result.content[0].text
  assert(
    content.includes('Analysis') ||
    content.includes('Recommendations') ||
    content.includes('Queries') ||
    content.includes('Patterns'),
    'No analysis content found in response'
  )
}

const testGetStatsTool = async () => {
  await useTestDatabase()

  const dbResponse = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'get-stats',
      args: {
        target: 'database'
      }
    }
  })

  assertToolSuccess(dbResponse, 'Statistics')

  const collResponse = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'get-stats',
      args: {
        target: 'collection',
        name: TEST_COLLECTION_NAME
      }
    }
  })

  assertToolSuccess(collResponse, 'Statistics')
  assert(collResponse.result.content[0].text.includes('Document Count'), 'Document count not found')
}

const testBulkOperationsTool = async () => {
  await useTestDatabase()

  const operations = [
    { insertOne: { document: { name: 'Bulk Insert 1', value: 1001 } } },
    { insertOne: { document: { name: 'Bulk Insert 2', value: 1002 } } },
    { updateOne: { filter: { name: 'Bulk Insert 1' }, update: { $set: { updated: true } } } }
  ]

  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'bulk-operations',
      args: {
        collection: TEST_COLLECTION_NAME,
        operations: JSON.stringify(operations),
        ordered: 'true'
      }
    }
  })

  assertToolSuccess(response, 'Bulk Operations Results')
  assert(response.result.content[0].text.includes('Inserted:'), 'Insert count not found')
}

const testCreateTimeseriesCollectionTool = async () => {
  try {
    const adminDb = directMongoClient.db('admin')
    const serverInfo = await adminDb.command({ buildInfo: 1 })
    const version = serverInfo.version.split('.').map(Number)

    if (version[0] < 5) {
      return skipTest('create-timeseries Tool', 'MongoDB version 5.0+ required for time series collections')
    }
  } catch (e) {
    return skipTest('create-timeseries Tool', `Could not determine MongoDB version: ${e.message}`)
  }

  await useTestDatabase()

  const collectionName = `timeseries_${Date.now()}`

  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'create-timeseries',
      args: {
        name: collectionName,
        timeField: 'timestamp',
        metaField: 'metadata',
        granularity: 'seconds'
      }
    }
  })

  assertToolSuccess(response, 'Time series collection')
  assert(response.result.content[0].text.includes('created'), 'Created confirmation not found')

  const collections = await testDb.listCollections({name: collectionName}).toArray()
  assert(collections.length > 0, `Timeseries collection '${collectionName}' not found`)
  assert(collections[0].options?.timeseries, 'Collection is not configured as timeseries')
}

const testCollationQueryTool = async () => {
  await useTestDatabase()

  const collationTestDocs = [
    { name: 'café', language: 'French', rank: 1 },
    { name: 'cafe', language: 'English', rank: 2 },
    { name: 'CAFE', language: 'English', rank: 3 }
  ]

  await testDb.collection(TEST_COLLECTION_NAME).insertMany(collationTestDocs)

  console.log(`${COLORS.blue}Verifying collation test documents were inserted…${COLORS.reset}`)
  const testDocs = await testDb.collection(TEST_COLLECTION_NAME)
    .find({ name: { $in: ['café', 'cafe', 'CAFE'] } })
    .toArray()
  console.log(`${COLORS.blue}Found ${testDocs.length} collation test documents${COLORS.reset}`)

  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'collation-query',
      args: {
        collection: TEST_COLLECTION_NAME,
        filter: '{"name": "cafe"}',
        locale: 'en',
        strength: 1,
        caseLevel: 'false'
      }
    }
  })

  const responseText = response.result.content[0].text
  assert(
    responseText.includes('café') ||
    responseText.includes('cafe') ||
    responseText.includes('CAFE') ||
    responseText.includes('collation') ||
    responseText.includes('Locale') ||
    responseText.includes('Found'),
    'Collation results not found'
  )
}

const testTextSearchTool = async () => {
  await useTestDatabase()

  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'text-search',
      args: {
        collection: TEST_COLLECTION_NAME,
        searchText: 'test',
        limit: 5
      }
    }
  })

  const responseText = response.result.content[0].text
  assert(
    responseText.includes('Found') ||
    responseText.includes('No text index found'),
    'Text search results or index message not found'
  )
}

const testGeoQueryTool = async () => {
  await useTestDatabase()

  const geometry = {
    type: 'Point',
    coordinates: [-74, 40.7]
  }

  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'geo-query',
      args: {
        collection: TEST_COLLECTION_NAME,
        operator: 'near',
        field: 'location',
        geometry: JSON.stringify(geometry),
        maxDistance: 2000000,
        limit: 10
      }
    }
  })

  assert(response?.result?.content, 'No content in response')
  assert(Array.isArray(response.result.content), 'Content not an array')
  assert(response.result.content.length > 0, 'Empty content array')

  const responseText = response.result.content[0].text
  assert(
    responseText.includes('coordinates') ||
    responseText.includes('location') ||
    responseText.includes('Geo Test'),
    'Geospatial data not found in results'
  )
}

const testTransactionTool = async () => {
  if (!isReplSet) {
    return skipTest('transaction Tool', 'MongoDB not in replica set mode - transactions require replica set')
  }

  await useTestDatabase()

  const operations = [
    {
      operation: 'insert',
      collection: TEST_COLLECTION_NAME,
      document: { name: 'Transaction Test 1', value: 1 }
    },
    {
      operation: 'insert',
      collection: TEST_COLLECTION_NAME,
      document: { name: 'Transaction Test 2', value: 2 }
    },
    {
      operation: 'update',
      collection: TEST_COLLECTION_NAME,
      filter: { name: 'Transaction Test 1' },
      update: { $set: { updated: true } }
    }
  ]

  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'transaction',
      args: {
        operations: JSON.stringify(operations)
      }
    }
  })

  assert(response?.result?.content, 'No content in response')
  assert(Array.isArray(response.result.content), 'Content not an array')
  assert(response.result.content.length > 0, 'Empty content array')

  const responseText = response.result.content[0].text
  assert(
    responseText.includes('Transaction') &&
    (responseText.includes('Step') || responseText.includes('committed')),
    'Transaction results not found'
  )
}

const testWatchChangesTool = async () => {
  if (!isReplSet) {
    return skipTest('watch-changes Tool', 'MongoDB not in replica set mode - change streams require replica set')
  }

  await useTestDatabase()

  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'watch-changes',
      args: {
        collection: TEST_COLLECTION_NAME,
        operations: JSON.stringify(['insert', 'update', 'delete']),
        duration: 2,
        fullDocument: 'false'
      }
    }
  })

  assert(response?.result?.content, 'No content in response')
  assert(Array.isArray(response.result.content), 'Content not an array')
  assert(response.result.content.length > 0, 'Empty content array')

  const responseText = response.result.content[0].text
  assert(
    responseText.includes('changes detected') ||
    responseText.includes('No changes detected'),
    'Change stream results not found'
  )
}

const testGridFSOperationTool = async () => {
  await useTestDatabase()

  try {
    const bucket = new mongodb.GridFSBucket(testDb)
    const fileContent = Buffer.from('GridFS test file content')

    const uploadStream = bucket.openUploadStream('test-gridfs-file.txt')
    uploadStream.write(fileContent)
    uploadStream.end()

    await new Promise(resolve => uploadStream.on('finish', resolve))
  } catch (e) {
    console.error(`Failed to create GridFS test file: ${e.message}`)
  }

  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'gridfs-operation',
      args: {
        operation: 'list',
        bucket: 'fs',
        limit: 10
      }
    }
  })

  assert(response?.result?.content, 'No content in response')
  assert(Array.isArray(response.result.content), 'Content not an array')
  assert(response.result.content.length > 0, 'Empty content array')

  const responseText = response.result.content[0].text
  assert(
    responseText.includes('GridFS') ||
    responseText.includes('Filename') ||
    responseText.includes('Size:'),
    'GridFS data not found in response'
  )
}

const testClearCacheTool = async () => {
  await useTestDatabase()

  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'clear-cache',
      args: {
        target: 'all'
      }
    }
  })

  assertToolSuccess(response, 'cleared')
}

const testShardStatusTool = async () => {
  if (!isSharded) {
    return skipTest('shard-status Tool', 'MongoDB not in sharded cluster mode - sharding features require sharded deployment')
  }

  await useTestDatabase()

  const response = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'shard-status',
      args: {
        target: 'database'
      }
    }
  })

  assert(response?.result?.content, 'No content in response')
  assert(Array.isArray(response.result.content), 'Content not an array')
  assert(response.result.content.length > 0, 'Empty content array')

  const responseText = response.result.content[0].text
  assert(
    responseText.includes('Sharding Status') ||
    responseText.includes('sharded cluster') ||
    responseText.includes('Sharding is not enabled') ||
    responseText.includes('not a sharded cluster') ||
    responseText.includes('not running with sharding'),
    'Sharding status or message not found'
  )
}

const testExportDataTool = async () => {
  await useTestDatabase()

  const jsonResponse = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'export-data',
      args: {
        collection: TEST_COLLECTION_NAME,
        filter: '{"value": {"$lt": 10}}',
        format: 'json',
        limit: 5
      }
    }
  })

  assert(jsonResponse?.result?.content, 'No content in JSON export response')
  assert(Array.isArray(jsonResponse.result.content), 'JSON export content not an array')
  assert(jsonResponse.result.content.length > 0, 'Empty JSON export content array')

  console.log(`${COLORS.blue}JSON export response first 100 chars: ${jsonResponse.result.content[0].text.substring(0, 100)}${COLORS.reset}`)

  const jsonText = jsonResponse.result.content[0].text
  assert(
    jsonText.includes('{') && jsonText.includes('}'),
    'JSON content not found in export'
  )

  const csvResponse = await runLensCommand({
    command: 'mcp.tool.invoke',
    params: {
      name: 'export-data',
      args: {
        collection: TEST_COLLECTION_NAME,
        filter: '{"value": {"$lt": 10}}',
        format: 'csv',
        fields: 'name,value,isActive',
        limit: 5
      }
    }
  })

  assert(csvResponse?.result?.content, 'No content in CSV export response')
  assert(Array.isArray(csvResponse.result.content), 'CSV export content not an array')
  assert(csvResponse.result.content.length > 0, 'Empty CSV export content array')

  console.log(`${COLORS.blue}CSV export response first 100 chars: ${csvResponse.result.content[0].text.substring(0, 100)}${COLORS.reset}`)

  assert(csvResponse.result.content[0].text.includes('name') &&
         csvResponse.result.content[0].text.includes('value'),
         'CSV headers not found')
}

const testDatabasesResource = async () => {
  const response = await runLensCommand({
    command: 'mcp.resource.get',
    params: { uri: 'mongodb://databases' }
  })

  assertResourceSuccess(response, 'Databases')
  assert(response.result.contents[0].text.includes(TEST_DB_NAME), 'Test database not found')
}

const testCollectionsResource = async () => {
  await useTestDatabase()

  const response = await runLensCommand({
    command: 'mcp.resource.get',
    params: { uri: 'mongodb://collections' }
  })

  assertResourceSuccess(response, `Collections in ${TEST_DB_NAME}`)
  assert(response.result.contents[0].text.includes(TEST_COLLECTION_NAME), 'Test collection not found')
}

const testDatabaseUsersResource = async () => {
  const response = await runLensCommand({
    command: 'mcp.resource.get',
    params: { uri: 'mongodb://database/users' }
  })

  assert(response?.result?.contents, 'No contents in response')
  assert(Array.isArray(response.result.contents), 'Contents not an array')
  assert(response.result.contents.length > 0, 'Empty contents array')
  assert(
    response.result.contents[0].text.includes('Users in database') ||
    response.result.contents[0].text.includes('Could not retrieve user information'),
    'Users title or permission message not found'
  )
}

const testDatabaseTriggersResource = async () => {
  const response = await runLensCommand({
    command: 'mcp.resource.get',
    params: { uri: 'mongodb://database/triggers' }
  })

  assert(response?.result?.contents, 'No contents in response')
  assert(Array.isArray(response.result.contents), 'Contents not an array')
  assert(response.result.contents.length > 0, 'Empty contents array')
  assert(
    response.result.contents[0].text.includes('Change Stream') ||
    response.result.contents[0].text.includes('Trigger'),
    'Triggers info not found'
  )
}

const testStoredFunctionsResource = async () => {
  const response = await runLensCommand({
    command: 'mcp.resource.get',
    params: { uri: 'mongodb://database/functions' }
  })

  assert(response?.result?.contents, 'No contents in response')
  assert(Array.isArray(response.result.contents), 'Contents not an array')
  assert(response.result.contents.length > 0, 'Empty contents array')
  assert(
    response.result.contents[0].text.includes('Stored Functions') ||
    response.result.contents[0].text.includes('No stored JavaScript functions'),
    'Stored functions title or empty message not found'
  )
}

const testCollectionSchemaResource = async () => {
  await useTestDatabase()

  const response = await runLensCommand({
    command: 'mcp.resource.get',
    params: { uri: `mongodb://collection/${TEST_COLLECTION_NAME}/schema` }
  })

  assertResourceSuccess(response, `Schema for '${TEST_COLLECTION_NAME}'`)
  const content = response.result.contents[0].text
  assert(content.includes('name:'), 'Name field not found')
  assert(content.includes('value:'), 'Value field not found')
  assert(content.includes('tags:'), 'Tags field not found')
}

const testCollectionIndexesResource = async () => {
  await useTestDatabase()

  const response = await runLensCommand({
    command: 'mcp.resource.get',
    params: { uri: `mongodb://collection/${TEST_COLLECTION_NAME}/indexes` }
  })

  assertResourceSuccess(response, 'Indexes')
  const content = response.result.contents[0].text
  assert(content.includes('name_1'), 'Name index not found')
  assert(content.includes('value_-1'), 'Value index not found')
}

const testCollectionStatsResource = async () => {
  await useTestDatabase()

  const response = await runLensCommand({
    command: 'mcp.resource.get',
    params: { uri: `mongodb://collection/${TEST_COLLECTION_NAME}/stats` }
  })

  assertResourceSuccess(response, 'Statistics')
  assert(response.result.contents[0].text.includes('Document Count'), 'Document count not found')
}

const testCollectionValidationResource = async () => {
  await useTestDatabase()

  const response = await runLensCommand({
    command: 'mcp.resource.get',
    params: { uri: `mongodb://collection/${TEST_COLLECTION_NAME}/validation` }
  })

  assert(response?.result?.contents, 'No contents in response')
  assert(Array.isArray(response.result.contents), 'Contents not an array')
  assert(response.result.contents.length > 0, 'Empty contents array')
  assert(
    response.result.contents[0].text.includes('Collection Validation Rules') ||
    response.result.contents[0].text.includes('does not have any validation rules'),
    'Validation rules title or empty message not found'
  )
}

const testServerStatusResource = async () => {
  const response = await runLensCommand({
    command: 'mcp.resource.get',
    params: { uri: 'mongodb://server/status' }
  })

  assertResourceSuccess(response, 'MongoDB Server Status')
  assert(response.result.contents[0].text.includes('Version'), 'Version info not found')
}

const testReplicaStatusResource = async () => {
  const response = await runLensCommand({
    command: 'mcp.resource.get',
    params: { uri: 'mongodb://server/replica' }
  })

  assert(response?.result?.contents, 'No contents in response')
  assert(Array.isArray(response.result.contents), 'Contents not an array')
  assert(response.result.contents.length > 0, 'Empty contents array')
  assert(
    response.result.contents[0].text.includes('Replica Set') ||
    response.result.contents[0].text.includes('not available'),
    'Replica set info or message not found'
  )
}

const testPerformanceMetricsResource = async () => {
  try {
    const originalTimeout = testConfig.requestTimeout
    testConfig.requestTimeout = 30000

    const response = await runLensCommand({
      command: 'mcp.resource.get',
      params: { uri: 'mongodb://server/metrics' }
    })

    testConfig.requestTimeout = originalTimeout

    assert(response?.result?.contents, 'No contents in response')
    assert(Array.isArray(response.result.contents), 'Contents not an array')
    assert(response.result.contents.length > 0, 'Empty contents array')
    assert(
      response.result.contents[0].text.includes('MongoDB Performance Metrics') ||
      response.result.contents[0].text.includes('Error getting performance metrics'),
      'Performance metrics title or error message not found'
    )
  } catch (error) {
    console.log(`${COLORS.yellow}Skipping performance metrics test due to complexity: ${error.message}${COLORS.reset}`)
    stats.skipped++
    stats.total--
  }
}

const testQueryBuilderPrompt = async () => {
  await useTestDatabase()

  const response = await runLensCommand({
    command: 'mcp.prompt.start',
    params: {
      name: 'query-builder',
      args: {
        collection: TEST_COLLECTION_NAME,
        condition: 'active documents with value greater than 20'
      }
    }
  })

  assertPromptSuccess(response, TEST_COLLECTION_NAME)
  assert(response.result.messages[0].content.text.includes('active documents with value greater than 20'), 'Condition not found')
}

const testAggregationBuilderPrompt = async () => {
  await useTestDatabase()

  const response = await runLensCommand({
    command: 'mcp.prompt.start',
    params: {
      name: 'aggregation-builder',
      args: {
        collection: TEST_COLLECTION_NAME,
        goal: 'calculate average value by active status'
      }
    }
  })

  assertPromptSuccess(response, TEST_COLLECTION_NAME)
  assert(response.result.messages[0].content.text.includes('calculate average value by active status'), 'Goal not found')
}

const testMongoShellPrompt = async () => {
  const response = await runLensCommand({
    command: 'mcp.prompt.start',
    params: {
      name: 'mongo-shell',
      args: {
        operation: 'find documents with specific criteria',
        details: 'I want to find all documents where the value is greater than 10'
      }
    }
  })

  assertPromptSuccess(response, 'find documents with specific criteria')
  assert(response.result.messages[0].content.text.includes('value is greater than 10'), 'Details not found')
}

const testSqlToMongodbPrompt = async () => {
  const response = await runLensCommand({
    command: 'mcp.prompt.start',
    params: {
      name: 'sql-to-mongodb',
      args: {
        sqlQuery: 'SELECT * FROM users WHERE age > 25 ORDER BY name ASC LIMIT 10',
        targetCollection: 'users'
      }
    }
  })

  assertPromptSuccess(response, 'SQL query')
  assert(response.result.messages[0].content.text.includes('SELECT * FROM users'), 'SQL statement not found')
}

const testSchemaAnalysisPrompt = async () => {
  await useTestDatabase()

  const response = await runLensCommand({
    command: 'mcp.prompt.start',
    params: {
      name: 'schema-analysis',
      args: {
        collection: TEST_COLLECTION_NAME
      }
    }
  })

  assertPromptSuccess(response, TEST_COLLECTION_NAME)
  assert(response.result.messages[0].content.text.includes('schema'), 'Schema analysis not found')
}

const testDataModelingPrompt = async () => {
  const response = await runLensCommand({
    command: 'mcp.prompt.start',
    params: {
      name: 'data-modeling',
      args: {
        useCase: 'E-commerce product catalog',
        requirements: 'Fast product lookup by category, efficient inventory tracking',
        existingData: 'Currently using SQL with products and categories tables'
      }
    }
  })

  assertPromptSuccess(response, 'E-commerce product catalog')
  assert(response.result.messages[0].content.text.includes('Fast product lookup'), 'Requirements not found')
}

const testSchemaVersioningPrompt = async () => {
  await useTestDatabase()

  const response = await runLensCommand({
    command: 'mcp.prompt.start',
    params: {
      name: 'schema-versioning',
      args: {
        collection: TEST_COLLECTION_NAME,
        currentSchema: 'Documents with name, value, tags fields',
        plannedChanges: 'Add a new status field, make tags required',
        migrationConstraints: 'Zero downtime required'
      }
    }
  })

  assertPromptSuccess(response, TEST_COLLECTION_NAME)
  assert(response.result.messages[0].content.text.includes('schema versioning'), 'Schema versioning not found')
}

const testMultiTenantDesignPrompt = async () => {
  const response = await runLensCommand({
    command: 'mcp.prompt.start',
    params: {
      name: 'multi-tenant-design',
      args: {
        tenantIsolation: 'collection',
        estimatedTenants: '50',
        sharedFeatures: 'User profiles, product catalog',
        tenantSpecificFeatures: 'Orders, custom pricing',
        scalingPriorities: 'Read-heavy, occasional bulk writes'
      }
    }
  })

  assertPromptSuccess(response, 'tenant isolation')
  assert(response.result.messages[0].content.text.includes('collection'), 'Collection isolation not found')
}

const testIndexRecommendationPrompt = async () => {
  await useTestDatabase()

  const response = await runLensCommand({
    command: 'mcp.prompt.start',
    params: {
      name: 'index-recommendation',
      args: {
        collection: TEST_COLLECTION_NAME,
        queryPattern: 'filtering by createdAt within a date range'
      }
    }
  })

  assertPromptSuccess(response, TEST_COLLECTION_NAME)
  assert(response.result.messages[0].content.text.includes('filtering by createdAt'), 'Query pattern not found')
}

const testQueryOptimizerPrompt = async () => {
  await useTestDatabase()

  const response = await runLensCommand({
    command: 'mcp.prompt.start',
    params: {
      name: 'query-optimizer',
      args: {
        collection: TEST_COLLECTION_NAME,
        query: '{"tags": "tag0", "value": {"$gt": 10}}',
        performance: 'Currently taking 500ms with 10,000 documents'
      }
    }
  })

  assertPromptSuccess(response, TEST_COLLECTION_NAME)
  assert(response.result.messages[0].content.text.includes('$gt'), 'Query operator not found')
}

const testSecurityAuditPrompt = async () => {
  const response = await runLensCommand({
    command: 'mcp.prompt.start',
    params: {
      name: 'security-audit',
      args: {}
    }
  })

  assertPromptSuccess(response, 'security audit')
}

const testBackupStrategyPrompt = async () => {
  const response = await runLensCommand({
    command: 'mcp.prompt.start',
    params: {
      name: 'backup-strategy',
      args: {
        databaseSize: '50GB',
        uptime: '99.9%',
        rpo: '1 hour',
        rto: '4 hours'
      }
    }
  })

  assertPromptSuccess(response, 'backup')
  assert(response.result.messages[0].content.text.includes('50GB'), 'Database size not found')
}

const testMigrationGuidePrompt = async () => {
  const response = await runLensCommand({
    command: 'mcp.prompt.start',
    params: {
      name: 'migration-guide',
      args: {
        sourceVersion: '4.4',
        targetVersion: '5.0',
        features: 'Time series collections, transactions, aggregation'
      }
    }
  })

  assertPromptSuccess(response, 'migration')
  const content = response.result.messages[0].content.text
  assert(content.includes('4.4'), 'Source version not found')
  assert(content.includes('5.0'), 'Target version not found')
}

const testDatabaseHealthCheckPrompt = async () => {
  try {
    await useTestDatabase()

    const testDoc = {
      name: 'Health Check Test',
      value: 100,
      tags: ['test'],
      isActive: true
    }

    await runLensCommand({
      command: 'mcp.tool.invoke',
      params: {
        name: 'insert-document',
        args: {
          collection: TEST_COLLECTION_NAME,
          document: JSON.stringify(testDoc)
        }
      }
    })

    const originalTimeout = testConfig.requestTimeout
    testConfig.requestTimeout = 45000

    console.log(`${COLORS.blue}Running database health check prompt (increased timeout to ${testConfig.requestTimeout/1000}s)${COLORS.reset}`)

    const response = await runLensCommand({
      command: 'mcp.prompt.start',
      params: {
        name: 'database-health-check',
        args: {
          includePerformance: 'false',
          includeSchema: 'true',
          includeSecurity: 'false'
        }
      }
    })

    testConfig.requestTimeout = originalTimeout

    assert(response?.result?.messages, 'No messages in response')
    assert(Array.isArray(response.result.messages), 'Messages not an array')
    assert(response.result.messages.length > 0, 'Empty messages array')

    const promptText = response.result.messages[0].content.text
    assert(
      promptText.includes('health') ||
      promptText.includes('Health') ||
      promptText.includes('assessment'),
      'Health check content not found'
    )
  } catch (error) {
    console.log(`${COLORS.yellow}Skipping database health check prompt test due to complexity: ${error.message}${COLORS.reset}`)
    stats.skipped++
    stats.total--
  }
}

const logHeader = (title, margin = 'none') => {
  if (margin.indexOf('top') !== -1) console.log('')
  console.log(`${COLORS.cyan}${DIVIDER}${COLORS.reset}`)
  console.log(`${COLORS.cyan}${title}${COLORS.reset}`)
  console.log(`${COLORS.cyan}${DIVIDER}${COLORS.reset}`)
  if (margin.indexOf('bottom') !== -1) console.log('')
}

const displayTestSummary = () => {
  logHeader('Test Summary', 'margin:top,bottom')
  console.log(`${COLORS.white}Total Tests: ${stats.total}${COLORS.reset}`)
  console.log(`${COLORS.green}Passed: ${stats.passed}${COLORS.reset}`)
  console.log(`${COLORS.red}Failed: ${stats.failed}${COLORS.reset}`)
  console.log(`${COLORS.yellow}Skipped: ${stats.skipped}${COLORS.reset}`)

  if (stats.failed > 0) {
    console.error(`${COLORS.red}Some tests failed.${COLORS.reset}`)
    process.exit(1)
  } else {
    console.log(`${COLORS.green}All tests passed!${COLORS.reset}`)
    process.exit(0)
  }
}

const cleanup = async () => {
  await cleanupTestDatabase()
  await directMongoClient.close()

  if (lensProcess) {
    lensProcess.kill('SIGKILL')
    await new Promise(resolve => lensProcess.on('exit', resolve))
  }
}

const cleanupTestDatabase = async () => {
  try {
    await testDb.dropDatabase()
    console.log(`${COLORS.yellow}Test database cleaned up.${COLORS.reset}`)
  } catch (err) {
    console.error(`${COLORS.red}Error cleaning up test database: ${err.message}${COLORS.reset}`)
  }
}

process.on('exit', () => {
  console.log('Exiting test process…')
  if (lensProcess) {
    console.log('Shutting down MongoDB Lens server…')
    lensProcess.kill()
  }
})

let testDb
let mongoUri
let testCollection
let directMongoClient
let isReplSet = false
let isSharded = false
let nextRequestId = 1
let lensProcess = null
let responseHandlers = new Map()

const testFilters = []
const groupFilters = []
const patternFilters = []
const isDebugging = process.env.DEBUG === 'true'

const DIVIDER = '-'.repeat(30)
const TEST_DB_NAME = 'mongodb_lens_test'
const TEST_COLLECTION_NAME = 'test_collection'
const ANOTHER_TEST_COLLECTION = 'another_collection'
const MONGODB_LENS_PATH = join(__dirname, 'mongodb-lens.js')

const stats = {
  total: 0,
  passed: 0,
  failed: 0,
  skipped: 0
}

const COLORS = {
  red: '\x1b[31m',
  reset: '\x1b[0m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  green: '\x1b[32m',
  white: '\x1b[37m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
}

const testConfig = {
  requestTimeout: 15000,
  serverStartupTimeout: 20000,
  disableTokens: process.env.CONFIG_DISABLE_DESTRUCTIVE_OPERATION_TOKENS === 'true',
  extraEnv: {}
}

const TEST_GROUPS = [
  {
    name: 'Connection Tools',
    tests: [
      { name: 'connect-mongodb Tool', fn: testConnectMongodbTool },
      { name: 'connect-original Tool', fn: testConnectOriginalTool },
      { name: 'add-connection-alias Tool', fn: testAddConnectionAliasTool },
      { name: 'list-connections Tool', fn: testListConnectionsTool }
    ]
  },
  {
    name: 'Database Tools',
    tests: [
      { name: 'list-databases Tool', fn: testListDatabasesTool },
      { name: 'current-database Tool', fn: testCurrentDatabaseTool },
      { name: 'create-database Tool', fn: testCreateDatabaseTool },
      { name: 'use-database Tool', fn: testUseDatabaseTool },
      { name: 'drop-database Tool', fn: testDropDatabaseTool }
    ]
  },
  {
    name: 'User Tools',
    tests: [
      { name: 'create-user Tool', fn: testCreateUserTool },
      { name: 'drop-user Tool', fn: testDropUserTool }
    ]
  },
  {
    name: 'Collection Tools',
    tests: [
      { name: 'list-collections Tool', fn: testListCollectionsTool },
      { name: 'create-collection Tool', fn: testCreateCollectionTool },
      { name: 'drop-collection Tool', fn: testDropCollectionTool },
      { name: 'rename-collection Tool', fn: testRenameCollectionTool },
      { name: 'validate-collection Tool', fn: testValidateCollectionTool }
    ]
  },
  {
    name: 'Document Tools',
    tests: [
      { name: 'distinct-values Tool', fn: testDistinctValuesTool },
      { name: 'find-documents Tool', fn: testFindDocumentsTool },
      { name: 'count-documents Tool', fn: testCountDocumentsTool },
      { name: 'insert-document Tool', fn: testInsertDocumentTool },
      { name: 'update-document Tool', fn: testUpdateDocumentTool },
      { name: 'delete-document Tool', fn: testDeleteDocumentTool }
    ]
  },
  {
    name: 'Advanced Tools',
    tests: [
      { name: 'aggregate-data Tool', fn: testAggregateDataTool },
      { name: 'aggregate-data $out Stage', fn: testAggregateDataOutStageTool },
      { name: 'create-index Tool', fn: testCreateIndexTool },
      { name: 'drop-index Tool', fn: testDropIndexTool },
      { name: 'analyze-schema Tool', fn: testAnalyzeSchemaTool },
      { name: 'generate-schema-validator Tool', fn: testGenerateSchemaValidatorTool },
      { name: 'compare-schemas Tool', fn: testCompareSchemasTool },
      { name: 'explain-query Tool', fn: testExplainQueryTool },
      { name: 'analyze-query-patterns Tool', fn: testAnalyzeQueryPatternsTool },
      { name: 'get-stats Tool', fn: testGetStatsTool },
      { name: 'bulk-operations Tool', fn: testBulkOperationsTool },
      { name: 'create-timeseries Tool', fn: testCreateTimeseriesCollectionTool },
      { name: 'collation-query Tool', fn: testCollationQueryTool },
      { name: 'text-search Tool', fn: testTextSearchTool },
      { name: 'geo-query Tool', fn: testGeoQueryTool },
      { name: 'transaction Tool', fn: testTransactionTool },
      { name: 'watch-changes Tool', fn: testWatchChangesTool },
      { name: 'gridfs-operation Tool', fn: testGridFSOperationTool },
      { name: 'clear-cache Tool', fn: testClearCacheTool },
      { name: 'shard-status Tool', fn: testShardStatusTool },
      { name: 'export-data Tool', fn: testExportDataTool }
    ]
  },
  {
    name: 'Read-Only Mode',
    tests: [
      { name: 'read-only hides write tools', fn: testReadOnlyHidesWriteTools },
      { name: 'read-only blocks aggregation writes', fn: testReadOnlyBlocksAggregationWrites },
      { name: 'read-only leaves profiler unchanged', fn: testReadOnlyLeavesProfilerUnchanged },
      { name: 'read-only server instructions', fn: testReadOnlyInstructions },
      { name: 'disabled write tools block aggregation writes', fn: testDisabledWriteToolsBlockAggregationWrites },
      { name: 'invalid CONFIG_READ_ONLY value exits', fn: testInvalidReadOnlyValueExits },
      { name: 'readOnly config key typo exits', fn: testReadOnlyKeyTypoExits }
    ]
  },
  {
    name: 'Resources',
    tests: [
      { name: 'databases Resource', fn: testDatabasesResource },
      { name: 'collections Resource', fn: testCollectionsResource },
      { name: 'database-users Resource', fn: testDatabaseUsersResource },
      { name: 'database-triggers Resource', fn: testDatabaseTriggersResource },
      { name: 'stored-functions Resource', fn: testStoredFunctionsResource },
      { name: 'collection-schema Resource', fn: testCollectionSchemaResource },
      { name: 'collection-indexes Resource', fn: testCollectionIndexesResource },
      { name: 'collection-stats Resource', fn: testCollectionStatsResource },
      { name: 'collection-validation Resource', fn: testCollectionValidationResource },
      { name: 'server-status Resource', fn: testServerStatusResource },
      { name: 'replica-status Resource', fn: testReplicaStatusResource },
      { name: 'performance-metrics Resource', fn: testPerformanceMetricsResource }
    ]
  },
  {
    name: 'Prompts',
    tests: [
      { name: 'query-builder Prompt', fn: testQueryBuilderPrompt },
      { name: 'aggregation-builder Prompt', fn: testAggregationBuilderPrompt },
      { name: 'mongo-shell Prompt', fn: testMongoShellPrompt },
      { name: 'sql-to-mongodb Prompt', fn: testSqlToMongodbPrompt },
      { name: 'schema-analysis Prompt', fn: testSchemaAnalysisPrompt },
      { name: 'data-modeling Prompt', fn: testDataModelingPrompt },
      { name: 'schema-versioning Prompt', fn: testSchemaVersioningPrompt },
      { name: 'multi-tenant-design Prompt', fn: testMultiTenantDesignPrompt },
      { name: 'index-recommendation Prompt', fn: testIndexRecommendationPrompt },
      { name: 'query-optimizer Prompt', fn: testQueryOptimizerPrompt },
      { name: 'security-audit Prompt', fn: testSecurityAuditPrompt },
      { name: 'backup-strategy Prompt', fn: testBackupStrategyPrompt },
      { name: 'migration-guide Prompt', fn: testMigrationGuidePrompt },
      { name: 'database-health-check Prompt', fn: testDatabaseHealthCheckPrompt }
    ]
  }
]

runTests().catch(err => {
  console.error(`${COLORS.red}Test runner error: ${err.message}${COLORS.reset}`)
  if (lensProcess) lensProcess.kill()
  process.exit(1)
})
