/*!
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert'
import { Runtime } from 'aws-sdk/clients/lambda'
import { mkdirpSync, mkdtemp, removeSync } from 'fs-extra'
import * as path from 'path'
import * as vscode from 'vscode'
import { DependencyManager } from '../../src/lambda/models/samLambdaRuntime'
import { helloWorldTemplate } from '../../src/lambda/models/samTemplates'
import { getSamCliContext } from '../../src/shared/sam/cli/samCliContext'
import { runSamCliInit, SamCliInitArgs } from '../../src/shared/sam/cli/samCliInit'
import { Language } from '../shared/codelens/codeLensUtils'
import { VSCODE_EXTENSION_ID } from '../shared/extensions'
import { fileExists } from '../shared/filesystemUtilities'
import { AddSamDebugConfigurationInput } from '../shared/sam/debugger/commands/addSamDebugConfiguration'
import { findParentProjectFile } from '../shared/utilities/workspaceUtils'
import { activateExtension, getCodeLenses, getTestWorkspaceFolder, sleep } from './integrationTestsUtilities'
import { setTestTimeout } from './globalSetup.test'
import { waitUntil } from '../shared/utilities/timeoutUtils'
import { AwsSamDebuggerConfiguration } from '../shared/sam/debugger/awsSamDebugConfiguration.gen'
import { ext } from '../shared/extensionGlobals'
import { AwsSamTargetType } from '../shared/sam/debugger/awsSamDebugConfiguration'

const projectFolder = getTestWorkspaceFolder()

/* Test constants go here */
const CODELENS_TIMEOUT: number = 60000
const CODELENS_RETRY_INTERVAL: number = 200
const DEBUG_TIMEOUT: number = 90000
const NO_DEBUG_SESSION_TIMEOUT: number = 5000
const NO_DEBUG_SESSION_INTERVAL: number = 100

interface TestScenario {
    displayName: string
    runtime: Runtime
    baseImage?: string
    path: string
    debugSessionType: string
    language: Language
    dependencyManager: DependencyManager
}

// When testing additional runtimes, consider pulling the docker container in buildspec\linuxIntegrationTests.yml
// to reduce the chance of automated tests timing out.
const scenarios: TestScenario[] = [
    // zips
    {
        runtime: 'nodejs10.x',
        displayName: 'nodejs10.x (ZIP)',
        path: 'hello-world/app.js',
        debugSessionType: 'pwa-node',
        language: 'javascript',
        dependencyManager: 'npm',
    },
    {
        runtime: 'nodejs12.x',
        displayName: 'nodejs12.x (ZIP)',
        path: 'hello-world/app.js',
        debugSessionType: 'pwa-node',
        language: 'javascript',
        dependencyManager: 'npm',
    },
    {
        runtime: 'nodejs14.x',
        displayName: 'nodejs14.x (ZIP)',
        path: 'hello-world/app.js',
        debugSessionType: 'pwa-node',
        language: 'javascript',
        dependencyManager: 'npm',
    },
    {
        runtime: 'python2.7',
        displayName: 'python2.7 (ZIP)',
        path: 'hello_world/app.py',
        debugSessionType: 'python',
        language: 'python',
        dependencyManager: 'pip',
    },
    {
        runtime: 'python3.6',
        displayName: 'python3.6 (ZIP)',
        path: 'hello_world/app.py',
        debugSessionType: 'python',
        language: 'python',
        dependencyManager: 'pip',
    },
    {
        runtime: 'python3.7',
        displayName: 'python3.7 (ZIP)',
        path: 'hello_world/app.py',
        debugSessionType: 'python',
        language: 'python',
        dependencyManager: 'pip',
    },
    {
        runtime: 'python3.8',
        displayName: 'python3.8 (ZIP)',
        path: 'hello_world/app.py',
        debugSessionType: 'python',
        language: 'python',
        dependencyManager: 'pip',
    },
    {
        runtime: 'java8',
        displayName: 'java8 (Gradle ZIP)',
        path: 'HelloWorldFunction/src/main/java/helloworld/App.java',
        debugSessionType: 'java',
        language: 'java',
        dependencyManager: 'gradle',
    },
    {
        runtime: 'java8.al2',
        displayName: 'java8.al2 (Maven ZIP)',
        path: 'HelloWorldFunction/src/main/java/helloworld/App.java',
        debugSessionType: 'java',
        language: 'java',
        dependencyManager: 'maven',
    },
    {
        runtime: 'java11',
        displayName: 'java11 (Gradle ZIP)',
        path: 'HelloWorldFunction/src/main/java/helloworld/App.java',
        debugSessionType: 'java',
        language: 'java',
        dependencyManager: 'gradle',
    },
    // { runtime: 'dotnetcore2.1', path: 'src/HelloWorld/Function.cs', debugSessionType: 'coreclr', language: 'csharp' },
    // { runtime: 'dotnetcore3.1', path: 'src/HelloWorld/Function.cs', debugSessionType: 'coreclr', language: 'csharp' },

    // images
    {
        runtime: 'nodejs10.x',
        displayName: 'nodejs10.x (Image)',
        baseImage: `amazon/nodejs10.x-base`,
        path: 'hello-world/app.js',
        debugSessionType: 'pwa-node',
        language: 'javascript',
        dependencyManager: 'npm',
    },
    {
        runtime: 'nodejs12.x',
        displayName: 'nodejs12.x (Image)',
        baseImage: `amazon/nodejs12.x-base`,
        path: 'hello-world/app.js',
        debugSessionType: 'pwa-node',
        language: 'javascript',
        dependencyManager: 'npm',
    },
    {
        runtime: 'nodejs14.x',
        displayName: 'nodejs14.x (Image)',
        baseImage: `amazon/nodejs14.x-base`,
        path: 'hello-world/app.js',
        debugSessionType: 'pwa-node',
        language: 'javascript',
        dependencyManager: 'npm',
    },
    {
        runtime: 'python3.6',
        displayName: 'python3.6 (Image)',
        baseImage: `amazon/python3.6-base`,
        path: 'hello_world/app.py',
        debugSessionType: 'python',
        language: 'python',
        dependencyManager: 'pip',
    },
    {
        runtime: 'python3.7',
        displayName: 'python3.7 (Image)',
        baseImage: `amazon/python3.7-base`,
        path: 'hello_world/app.py',
        debugSessionType: 'python',
        language: 'python',
        dependencyManager: 'pip',
    },
    // {
    //     runtime: 'python3.8',
    //     displayName: 'python3.8 (Image)',
    //     baseImage: `amazon/python3.8-base`,
    //     path: 'hello_world/app.py',
    //     debugSessionType: 'python',
    //     language: 'python',
    //     dependencyManager: 'pip',
    // },
    {
        runtime: 'java8',
        displayName: 'java8 (Maven Image)',
        path: 'HelloWorldFunction/src/main/java/helloworld/App.java',
        baseImage: `amazon/java8-base`,
        debugSessionType: 'java',
        language: 'java',
        dependencyManager: 'maven',
    },
    {
        runtime: 'java8.al2',
        displayName: 'java8.al2 (Gradle Image)',
        path: 'HelloWorldFunction/src/main/java/helloworld/App.java',
        baseImage: `amazon/java8.al2-base`,
        debugSessionType: 'java',
        language: 'java',
        dependencyManager: 'gradle',
    },
    {
        runtime: 'java11',
        displayName: 'java11 (Maven Image)',
        path: 'HelloWorldFunction/src/main/java/helloworld/App.java',
        baseImage: `amazon/java11-base`,
        debugSessionType: 'java',
        language: 'java',
        dependencyManager: 'maven',
    },
    // { runtime: 'dotnetcore2.1', path: 'src/HelloWorld/Function.cs', debugSessionType: 'coreclr', language: 'csharp' },
    // { runtime: 'dotnetcore3.1', path: 'src/HelloWorld/Function.cs', debugSessionType: 'coreclr', language: 'csharp' },
]

async function openSamAppFile(applicationPath: string): Promise<vscode.Uri> {
    const document = await vscode.workspace.openTextDocument(applicationPath)

    return document.uri
}

function tryRemoveFolder(fullPath: string) {
    try {
        removeSync(fullPath)
    } catch (e) {
        console.error(`Failed to remove path ${fullPath}`, e)
    }
}

async function getAddConfigCodeLens(documentUri: vscode.Uri): Promise<vscode.CodeLens[] | undefined> {
    return waitUntil(
        async () => {
            try {
                let codeLenses = await getCodeLenses(documentUri)
                if (!codeLenses || codeLenses.length === 0) {
                    return undefined
                }

                // omnisharp spits out some undefined code lenses for some reason, we filter them because they are
                // not shown to the user and do not affect how our extension is working
                codeLenses = codeLenses.filter(codeLens => {
                    if (codeLens.command && codeLens.command.arguments && codeLens.command.arguments.length === 3) {
                        return codeLens.command.command === 'aws.pickAddSamDebugConfiguration'
                    }

                    return false
                })

                if (codeLenses.length > 0) {
                    return codeLenses || []
                }
            } catch (e) {
                console.log(`sam.test.ts: getAddConfigCodeLens(): failed, retrying:\n${e}`)
            }

            return undefined
        },
        { timeout: CODELENS_TIMEOUT, interval: CODELENS_RETRY_INTERVAL, truthy: false }
    )
}

/**
 * Returns a string if there is a validation issue, undefined if there is no issue.
 */
function validateSamDebugSession(
    debugSession: vscode.DebugSession,
    expectedName: string,
    expectedRuntime: string
): string | undefined {
    const runtime = (debugSession.configuration as any).runtime
    const name = (debugSession.configuration as any).name
    if (name !== expectedName || runtime !== expectedRuntime) {
        const failMsg =
            `Unexpected DebugSession (expected name="${expectedName}" runtime="${expectedRuntime}"):` +
            `\n${JSON.stringify(debugSession)}`
        return failMsg
    }
}

/**
 * Simulates pressing 'F5' to start debugging. Sets up events to see if debugging was successful
 * or not. Since we are not checking outputs we treat a successful operation as the debug session
 * closing on its own (i.e. the container executable terminated)
 *
 * @param scenario Scenario to run, used for logging information
 * @param scenarioIndex Scenario number, used for logging information
 * @param testConfig Debug configuration to start the debugging with
 * @param testDisposables All events registered by this function are pushed here to be removed later
 * @param sessionLog An array where session logs are stored
 */
async function startDebugger(
    scenario: TestScenario,
    scenarioIndex: number,
    target: AwsSamTargetType,
    testConfig: vscode.DebugConfiguration,
    testDisposables: vscode.Disposable[],
    sessionLog: string[]
) {
    function logSession(startEnd: 'START' | 'END', name: string) {
        sessionLog.push(
            `scenario ${scenarioIndex}.${target.toString()[0]} ${startEnd.padEnd(5, ' ')} ${target}/${
                scenario.displayName
            }: ${name}`
        )
    }

    // Create a Promise that encapsulates our success critera
    const success = new Promise<void>((resolve, reject) => {
        testDisposables.push(
            vscode.debug.onDidTerminateDebugSession(async session => {
                logSession('END', session.name)
                const sessionRuntime = (session.configuration as any).runtime
                if (!sessionRuntime) {
                    // It's a coprocess, ignore it.
                    return
                }
                const failMsg = validateSamDebugSession(session, testConfig.name, scenario.runtime)
                if (failMsg) {
                    reject(new Error(failMsg))
                }
                resolve()
                await stopDebugger(`${scenario.runtime} / onDidTerminateDebugSession`)
            })
        )
    })

    // Executes the 'F5' action
    await vscode.debug.startDebugging(undefined, testConfig).then(
        async () => {
            logSession('START', vscode.debug.activeDebugSession!.name)

            await sleep(400)
            await continueDebugger()
            await sleep(400)
            await continueDebugger()
            await sleep(400)
            await continueDebugger()

            await success
        },
        err => {
            throw err as Error
        }
    )
}

async function continueDebugger(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.debug.continue')
}

async function stopDebugger(logMsg: string | undefined): Promise<void> {
    if (logMsg) {
        console.log(`sam.test.ts: stopDebugger(): ${logMsg}`)
    }
    await vscode.commands.executeCommand('workbench.action.debug.stop')
}

async function closeAllEditors(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
}

async function activateExtensions(): Promise<void> {
    console.log('Activating extensions...')
    await activateExtension(VSCODE_EXTENSION_ID.python)
    await activateExtension(VSCODE_EXTENSION_ID.java)
    await activateExtension(VSCODE_EXTENSION_ID.javadebug)
    console.log('Extensions activated')
}

async function configurePythonExtension(): Promise<void> {
    const configPy = vscode.workspace.getConfiguration('python')
    // Disable linting to silence some of the Python extension's log spam
    await configPy.update('linting.pylintEnabled', false, false)
    await configPy.update('linting.enabled', false, false)
}

async function configureAwsToolkitExtension(): Promise<void> {
    const configAws = vscode.workspace.getConfiguration('aws')
    // Prevent the extension from preemptively cancelling a 'sam local' run
    await configAws.update('samcli.debug.attach.timeout.millis', DEBUG_TIMEOUT, false)
}

describe('SAM Integration Tests', async function () {
    const samApplicationName = 'testProject'
    /**
     * Breadcrumbs from each process, printed at end of all scenarios to give
     * us an idea of the timeline.
     */
    const sessionLog: string[] = []
    let javaLanguageSetting: string | undefined
    const config = vscode.workspace.getConfiguration('java')
    let testSuiteRoot: string

    before(async function () {
        javaLanguageSetting = config.get('server.launchMode')
        config.update('server.launchMode', 'Standard')

        await activateExtensions()
        await configureAwsToolkitExtension()
        await configurePythonExtension()

        testSuiteRoot = await mkdtemp(path.join(projectFolder, 'inttest'))
        console.log('testSuiteRoot: ', testSuiteRoot)
        mkdirpSync(testSuiteRoot)
    })

    after(async function () {
        tryRemoveFolder(testSuiteRoot)
        // Print a summary of session that were seen by `onDidStartDebugSession`.
        const sessionReport = sessionLog.map(x => `    ${x}`).join('\n')
        config.update('server.launchMode', javaLanguageSetting)
        console.log(`DebugSessions seen in this run:\n${sessionReport}`)
    })

    for (let scenarioIndex = 0; scenarioIndex < scenarios.length; scenarioIndex++) {
        const scenario = scenarios[scenarioIndex]

        describe(`SAM Application Runtime: ${scenario.displayName}`, async function () {
            let runtimeTestRoot: string

            before(async function () {
                runtimeTestRoot = path.join(testSuiteRoot, scenario.runtime)
                console.log('runtimeTestRoot: ', runtimeTestRoot)
                mkdirpSync(runtimeTestRoot)
            })

            after(async function () {
                // don't clean up after java tests so the java language server doesn't freak out
                if (scenario.language !== 'java') {
                    tryRemoveFolder(runtimeTestRoot)
                }
            })

            function log(o: any) {
                console.log(`sam.test.ts: scenario ${scenarioIndex} (${scenario.displayName}): ${o}`)
            }

            /**
             * This suite cleans up at the end of each test.
             */
            describe('Starting from scratch', async function () {
                let testDir: string

                beforeEach(async function () {
                    testDir = await mkdtemp(path.join(runtimeTestRoot, 'test-'))
                    log(`testDir: ${testDir}`)
                })

                afterEach(async function () {
                    // don't clean up after java tests so the java language server doesn't freak out
                    if (scenario.language !== 'java') {
                        tryRemoveFolder(testDir)
                    }
                })

                it('creates a new SAM Application (happy path)', async function () {
                    await createSamApplication(testDir)

                    // Check for readme file
                    const readmePath = path.join(testDir, samApplicationName, 'README.md')
                    assert.ok(await fileExists(readmePath), `Expected SAM App readme to exist at ${readmePath}`)
                })
            })

            /**
             * This suite makes a sam app that all tests operate on.
             * Cleanup happens at the end of the suite.
             */
            describe(`Starting with a newly created ${scenario.displayName} SAM Application...`, async function () {
                let testDisposables: vscode.Disposable[]

                let testDir: string
                let samAppCodeUri: vscode.Uri
                let appPath: string
                let cfnTemplatePath: string

                before(async function () {
                    testDir = await mkdtemp(path.join(runtimeTestRoot, 'samapp-'))
                    log(`testDir: ${testDir}`)

                    await createSamApplication(testDir)
                    appPath = path.join(testDir, samApplicationName, scenario.path)
                    cfnTemplatePath = path.join(testDir, samApplicationName, 'template.yaml')
                    assert.ok(await fileExists(cfnTemplatePath), `Expected SAM template to exist at ${cfnTemplatePath}`)

                    samAppCodeUri = await openSamAppFile(appPath)
                })

                beforeEach(async function () {
                    testDisposables = []
                    await closeAllEditors()
                })

                afterEach(async function () {
                    testDisposables.forEach(d => d.dispose())
                    await stopDebugger(undefined)
                })

                after(async function () {
                    // don't clean up after java tests so the java language server doesn't freak out
                    if (scenario.language !== 'java') {
                        tryRemoveFolder(testDir)
                    }
                })

                it('produces an error when creating a SAM Application to the same location', async function () {
                    await assert.rejects(
                        createSamApplication(testDir),
                        /directory already exists/,
                        'Promise was not rejected'
                    )
                })

                it('produces an Add Debug Configuration codelens', async function () {
                    if (vscode.version.startsWith('1.42') && scenario.language === 'python') {
                        this.skip()
                    }

                    const codeLenses = await getAddConfigCodeLens(samAppCodeUri)
                    assert.ok(codeLenses && codeLenses.length === 2)

                    let manifestFile: RegExp
                    switch (scenario.language) {
                        case 'javascript':
                            manifestFile = /^package\.json$/
                            break
                        case 'python':
                            manifestFile = /^requirements\.txt$/
                            break
                        case 'csharp':
                            manifestFile = /^.*\.csproj$/
                            break
                        case 'java':
                            if (scenario.dependencyManager === 'maven') {
                                manifestFile = /^.*pom\.xml$/
                                break
                            } else if (scenario.dependencyManager === 'gradle') {
                                manifestFile = /^.*build\.gradle$/
                                break
                            }
                            assert.fail(`invalid dependency manager for java: ${scenario.dependencyManager}`)
                            break
                        default:
                            assert.fail('invalid scenario language')
                    }

                    const projectRoot = await findParentProjectFile(samAppCodeUri, manifestFile)
                    assert.ok(projectRoot, 'projectRoot not found')
                    for (const codeLens of codeLenses) {
                        assertCodeLensReferencesHasSameRoot(codeLens, projectRoot!)
                    }
                })

                it('target=api: invokes and attaches on debug request (F5)', async function () {
                    if (vscode.version.startsWith('1.42') && scenario.language === 'python') {
                        this.skip()
                    }

                    setTestTimeout(this.test?.fullTitle(), DEBUG_TIMEOUT)
                    await testTarget('api', {
                        api: {
                            path: '/hello',
                            httpMethod: 'get',
                            headers: { 'accept-language': 'fr-FR' },
                        },
                    })
                })

                it('target=template: invokes and attaches on debug request (F5)', async function () {
                    if (vscode.version.startsWith('1.42') && scenario.language === 'python') {
                        this.skip()
                    }

                    setTestTimeout(this.test?.fullTitle(), DEBUG_TIMEOUT)
                    await testTarget('template')
                })

                async function testTarget(target: AwsSamTargetType, extraConfig: any = {}) {
                    // Allow previous sessions to go away.
                    const noDebugSession: boolean | undefined = await waitUntil(
                        async () => vscode.debug.activeDebugSession === undefined,
                        { timeout: NO_DEBUG_SESSION_TIMEOUT, interval: NO_DEBUG_SESSION_INTERVAL, truthy: true }
                    )

                    // We exclude the Node debug type since it causes the most erroneous failures with CI.
                    // However, the fact that there are sessions from previous tests is still an issue, so
                    // a warning will be logged under the current session.
                    if (!noDebugSession) {
                        assert.strictEqual(
                            vscode.debug.activeDebugSession!.type,
                            'pwa-node',
                            `unexpected debug session in progress: ${JSON.stringify(
                                vscode.debug.activeDebugSession,
                                undefined,
                                2
                            )}`
                        )

                        sessionLog.push(`(WARNING) Unexpected debug session ${vscode.debug.activeDebugSession!.name}`)
                    }

                    const testConfig = {
                        type: 'aws-sam',
                        request: 'direct-invoke',
                        name: `test-config-${scenarioIndex}`,
                        invokeTarget: {
                            target: target,
                            // Resource defined in `src/testFixtures/.../template.yaml`.
                            logicalId: 'HelloWorldFunction',
                            templatePath: cfnTemplatePath,
                        },
                        ...extraConfig,
                    } as AwsSamDebuggerConfiguration

                    // runtime is optional for ZIP, but required for image-based
                    if (scenario.baseImage) {
                        testConfig.lambda = {
                            runtime: scenario.runtime,
                        }
                    }

                    // XXX: force load since template registry seems a bit flakey
                    await ext.templateRegistry.addItemToRegistry(vscode.Uri.file(cfnTemplatePath))

                    await startDebugger(scenario, scenarioIndex, target, testConfig, testDisposables, sessionLog)
                }
            })
        })

        async function createSamApplication(location: string): Promise<void> {
            const initArguments: SamCliInitArgs = {
                name: samApplicationName,
                location: location,
                dependencyManager: scenario.dependencyManager,
            }
            if (scenario.baseImage) {
                initArguments.baseImage = scenario.baseImage
            } else {
                initArguments.runtime = scenario.runtime
                initArguments.template = helloWorldTemplate
            }
            const samCliContext = getSamCliContext()
            await runSamCliInit(initArguments, samCliContext)
        }

        function assertCodeLensReferencesHasSameRoot(codeLens: vscode.CodeLens, expectedUri: vscode.Uri) {
            assert.ok(codeLens.command, 'CodeLens did not have a command')
            const command = codeLens.command!

            assert.ok(command.arguments, 'CodeLens command had no arguments')
            const commandArguments = command.arguments!

            assert.strictEqual(commandArguments.length, 3, 'CodeLens command had unexpected arg count')
            const params: AddSamDebugConfigurationInput = commandArguments[0]
            assert.ok(params, 'unexpected non-defined command argument')

            assert.strictEqual(path.dirname(params.rootUri.fsPath), path.dirname(expectedUri.fsPath))
        }
    }
})
