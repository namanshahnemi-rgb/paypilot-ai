// Jenkins pipeline for PayPilot AI.
//
// Runs on a Linux agent (for example a Jenkins controller in Docker Desktop)
// or a Windows agent. Agent requirements: Node.js 22.18 or newer with npm,
// and, for the Docker stages, a Docker CLI that can reach a Docker daemon.
//
// Stages, in order:
//   CI (always): checkout, install from lockfiles, type checks, unit tests,
//     lint, builds, dependency audit.
//   Image (BUILD_IMAGE): Docker build, PostgreSQL integration tests inside the
//     image against a throwaway database, a check that the runtime image has
//     no test-only code or dependencies, and a smoke test of the image.
//   Publish (PUBLISH_IMAGE, main branch only): push the tested image to GHCR.
//   Deploy (DEPLOY_TO_RENDER, main branch only, after a manual approval):
//     trigger the Render deploy hook, then check the public health endpoint.
// Publish and Deploy run only if every earlier stage passed, and never by
// default.
//
// No credentials are written here. Publish and Deploy read them from Jenkins
// credentials (IDs below), which Jenkins masks in the log. The tests mock
// PayPal and the AI model; no .env file is read and no payment is made.

// Jenkins credential IDs (script bindings, so every stage can read them).
GHCR_CREDENTIALS_ID = 'ghcr-publish'              // Username with password: GitHub user + PAT (write:packages)
RENDER_HOOK_CREDENTIALS_ID = 'render-deploy-hook'   // Secret text: the Render deploy hook URL

// Node.js check run inside the runtime image (Image smoke test). One line,
// single quotes only, so it can be passed in double quotes by sh and bat.
IMAGE_CONTENTS_CHECK = '''const fs=require('fs');const bad=[];try{require.resolve('better-sqlite3');bad.push('better-sqlite3 is installed')}catch(e){}const files=fs.readdirSync('dist');for(const f of files){if(f.includes('.test.')||f.startsWith('orderRegistry.')||f.startsWith('database.'))bad.push('dist/'+f)}if(bad.length){console.error('Not allowed in the runtime image: '+bad.join(', '));process.exit(1)}console.log('Runtime image contents OK: '+files.filter(f=>f.endsWith('.js')).length+' modules, no SQLite driver, no tests.')'''

// Runs a shell command on either agent type. Not named run: that name is a
// Jenkins Pipeline symbol, and Declarative rejects run('...') inside steps.
def executeCommand(String command) {
  if (isUnix()) {
    sh command
  } else {
    bat command
  }
}

def runOutput(String command) {
  return isUnix() ? sh(returnStdout: true, script: command).trim() : bat(returnStdout: true, script: "@${command}").trim()
}

// Runs an npm command in one package folder. On failure, stops the build
// with a message naming the package, the command, and what to check.
def runNpm(String folder, String command, String hint) {
  dir(folder) {
    try {
      executeCommand("npm ${command}")
    } catch (hudson.AbortException err) {
      error("[${folder}] 'npm ${command}' failed. ${hint}")
    }
  }
}

// Audits one package's dependencies with npm audit. High or critical
// findings, or an audit that cannot run, mark the build UNSTABLE.
def auditDependencies(String folder) {
  def report = "reports/npm-audit-${folder}.json"
  dir(folder) {
    echo "npm audit for ${folder}. A non-zero exit code in this step only means findings were reported."
    if (isUnix()) {
      sh(returnStatus: true, script: 'npm audit')
      sh(returnStatus: true, script: "npm audit --json > ../${report}")
    } else {
      bat(returnStatus: true, script: 'npm audit')
      bat(returnStatus: true, script: "npm audit --json > ..\\${report.replace('/', '\\')}")
    }
  }

  // Kept free of double quotes, backslashes, and dollar signs so it can be
  // passed to node -e on either shell.
  def summarize = '''const fs=require('fs');const [file,pkg]=process.argv.slice(1);let r;try{r=JSON.parse(fs.readFileSync(file,'utf8'))}catch(e){console.log('npm audit for '+pkg+' produced no readable report.');console.log('AUDIT_RESULT=error');process.exit(0)}if(r.error){console.log('npm audit for '+pkg+' could not run: '+(r.error.code||'unknown error')+'.');console.log('AUDIT_RESULT=error');process.exit(0)}const v=(r.metadata&&r.metadata.vulnerabilities)||{};const n=k=>v[k]||0;const total=n('critical')+n('high')+n('moderate')+n('low')+n('info');console.log('npm audit summary for '+pkg+': critical='+n('critical')+', high='+n('high')+', moderate='+n('moderate')+', low='+n('low')+', info='+n('info')+' (total '+total+').');console.log('AUDIT_RESULT='+(n('critical')+n('high')>0?'high':total>0?'other':'clean'))'''
  def summary = runOutput("node -e \"${summarize}\" ${report} ${folder}")
  echo summary

  if (summary.contains('AUDIT_RESULT=high')) {
    unstable("npm audit found high or critical vulnerabilities in ${folder}. See the report above and ${report}.")
  } else if (summary.contains('AUDIT_RESULT=error')) {
    unstable("npm audit could not check ${folder} (for example, the npm registry was unreachable), so its vulnerability status is unknown.")
  }
}

def isMainBranch() {
  def branch = env.BRANCH_NAME ?: env.GIT_BRANCH ?: ''
  return branch == 'main' || branch.endsWith('/main')
}

pipeline {
  agent any

  options {
    // The Checkout stage below checks out the job's configured SCM.
    skipDefaultCheckout()
    disableConcurrentBuilds()
    timeout(time: 45, unit: 'MINUTES')
    buildDiscarder(logRotator(numToKeepStr: '20'))
  }

  parameters {
    booleanParam(name: 'BUILD_IMAGE', defaultValue: true,
      description: 'Build the backend Docker image, run the PostgreSQL integration tests inside it, and smoke-test it. Needs Docker on the agent.')
    booleanParam(name: 'PUBLISH_IMAGE', defaultValue: false,
      description: 'Push the tested image to GHCR (main branch only). Needs the ghcr-publish credential.')
    booleanParam(name: 'DEPLOY_TO_RENDER', defaultValue: false,
      description: 'After publishing, ask for approval, then trigger the Render deploy hook (main branch only). Needs the render-deploy-hook credential.')
    string(name: 'GHCR_IMAGE', defaultValue: 'ghcr.io/namanshahnemi-rgb/paypilot-api',
      description: 'Image name to publish (lowercase).')
    string(name: 'PRODUCTION_API_URL', defaultValue: 'https://paypilot-api-latest.onrender.com',
      description: 'Checked with read-only GET requests after a deploy.')
    string(name: 'PRODUCTION_FRONTEND_ORIGIN', defaultValue: 'https://rapid-fire-08f4.namanshahnemi.workers.dev',
      description: 'The frontend origin the production API must allow (CORS check after a deploy).')
  }

  environment {
    CI = 'true'
    // Keep npm ci output focused; the audit runs in its own stage.
    NPM_CONFIG_AUDIT = 'false'
    NPM_CONFIG_FUND = 'false'
    NPM_CONFIG_UPDATE_NOTIFIER = 'false'
  }

  stages {
    stage('Checkout') {
      steps {
        script {
          def scmVars = checkout scm
          env.GIT_COMMIT = scmVars.GIT_COMMIT ?: env.GIT_COMMIT ?: ''
          env.GIT_BRANCH = scmVars.GIT_BRANCH ?: env.GIT_BRANCH ?: ''
          // Names for this build's local images, containers, and network.
          env.CI_TAG = "ci-${env.BUILD_NUMBER}"
          env.CI_NAME = "paypilot-ci-${env.BUILD_NUMBER}"
        }
        script {
          if (isUnix()) {
            sh 'rm -rf reports && mkdir reports'
          } else {
            bat 'if exist reports rmdir /s /q reports'
            bat 'mkdir reports'
          }
        }
      }
    }

    stage('Check toolchain') {
      steps {
        executeCommand('node --version')
        executeCommand('npm --version')
        executeCommand('''node -e "const [a,b]=process.versions.node.split('.').map(Number);if(a<22||(a===22&&b<18)){console.error('Node.js '+process.versions.node+' is too old: PayPilot CI needs Node.js 22.18 or newer, because the client tests run TypeScript files directly with node --test.');process.exit(1)}"''')
      }
    }

    stage('Install dependencies') {
      steps {
        script {
          def hint = 'Check that package-lock.json is committed and in sync with package.json (run npm install locally and commit the lockfile), and that the agent can reach the npm registry.'
          runNpm('server', 'ci', hint)
          runNpm('client', 'ci', hint)
        }
      }
    }

    stage('Type check') {
      steps {
        script {
          // Includes the test files, which the production build also compiles.
          runNpm('server', 'exec -- tsc --noEmit -p .', 'TypeScript reported errors in server/. Reproduce with npx tsc --noEmit -p . in server/.')
          runNpm('client', 'exec -- tsc -b', 'TypeScript reported errors in client/. Reproduce with npx tsc -b in client/.')
        }
      }
    }

    stage('Unit tests') {
      steps {
        script {
          runNpm('server', 'test', 'A server test failed; the output above names it. The tests mock PayPal and the AI model, so no credentials or running services are needed. Reproduce with npm test in server/.')
          runNpm('client', 'test', 'A client test failed; the output above names it. Reproduce with npm test in client/.')
        }
      }
    }

    stage('Lint') {
      steps {
        script {
          runNpm('client', 'run lint', 'oxlint reported errors. Reproduce with npm run lint in client/.')
          echo 'server/ defines no lint script; its type check runs in the Type check stage.'
        }
      }
    }

    stage('Build') {
      steps {
        script {
          runNpm('server', 'run build', 'TypeScript compilation failed. Reproduce with npm run build in server/.')
          runNpm('client', 'run build', 'The type check (tsc -b) or the Vite production build failed. Reproduce with npm run build in client/.')
        }
      }
    }

    stage('Dependency audit') {
      steps {
        script {
          auditDependencies('server')
          auditDependencies('client')
        }
      }
    }

    stage('Docker image') {
      when { expression { params.BUILD_IMAGE } }
      steps {
        dir('server') {
          // The build stage (all dependencies and sources) runs the tests
          // below; the runtime stage is the image that would be published.
          executeCommand("docker build --pull --target build -t paypilot-server-build:${env.CI_TAG} .")
          executeCommand("docker build -t paypilot-server:${env.CI_TAG} .")
        }
      }
    }

    stage('Integration tests') {
      when { expression { params.BUILD_IMAGE } }
      steps {
        script {
          // A throwaway PostgreSQL on a private Docker network, with no
          // published ports, so no password is needed and no data outside
          // this build is touched. Removed in the post section.
          executeCommand("docker network create ${env.CI_NAME}")
          executeCommand("docker run -d --name ${env.CI_NAME}-db --network ${env.CI_NAME} -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=paypilot_ci postgres:17-alpine")
          def ready = false
          for (int attempt = 0; attempt < 30 && !ready; attempt++) {
            def status = isUnix()
              ? sh(returnStatus: true, script: "docker exec ${env.CI_NAME}-db pg_isready -U postgres -d paypilot_ci")
              : bat(returnStatus: true, script: "docker exec ${env.CI_NAME}-db pg_isready -U postgres -d paypilot_ci")
            ready = (status == 0)
            if (!ready) { sleep(time: 2, unit: 'SECONDS') }
          }
          if (!ready) { error('The throwaway PostgreSQL container did not become ready.') }
          try {
            executeCommand("docker run --rm --network ${env.CI_NAME} -e DATABASE_URL=postgresql://postgres@${env.CI_NAME}-db:5432/paypilot_ci paypilot-server-build:${env.CI_TAG} npm run test:integration")
          } catch (hudson.AbortException err) {
            error('The PostgreSQL integration tests failed; the output above names the test. Reproduce with npm run test:integration in server/ against a local database.')
          }
        }
      }
    }

    stage('Image smoke test') {
      when { expression { params.BUILD_IMAGE } }
      steps {
        script {
          // The runtime image holds only production code and dependencies:
          // no SQLite driver, no compiled tests, no SQLite registry (PP-27).
          try {
            executeCommand("docker run --rm paypilot-server:${env.CI_TAG} node -e \"" + IMAGE_CONTENTS_CHECK + "\"")
          } catch (hudson.AbortException err) {
            error('The runtime image contains test-only code or dependencies; see the line above.')
          }
          // Runs the runtime image with placeholder PayPal values (no PayPal
          // call is made) and checks headers, CORS, origin and JSON rules.
          executeCommand("docker run -d --name ${env.CI_NAME}-api --network ${env.CI_NAME} -e DATABASE_URL=postgresql://postgres@${env.CI_NAME}-db:5432/paypilot_ci -e CLIENT_ORIGINS=https://smoke.example -e PAYPAL_CLIENT_ID=ci-placeholder -e PAYPAL_CLIENT_SECRET=ci-placeholder paypilot-server:${env.CI_TAG}")
          try {
            executeCommand("docker run --rm --network ${env.CI_NAME} -e SMOKE_ALLOW_POST=1 paypilot-server-build:${env.CI_TAG} node scripts/smoke-test.mjs http://${env.CI_NAME}-api:4000 https://smoke.example")
          } catch (hudson.AbortException err) {
            executeCommand("docker logs ${env.CI_NAME}-api")
            error('The image smoke test failed; see the checks and the API log above.')
          }
          // The image must stop cleanly on SIGTERM (graceful shutdown).
          executeCommand("docker stop -t 15 ${env.CI_NAME}-api")
          def exitCode = runOutput("docker inspect -f {{.State.ExitCode}} ${env.CI_NAME}-api")
          if (exitCode != '0') { error("The API container exited with code ${exitCode} on SIGTERM instead of shutting down cleanly.") }
        }
      }
    }

    stage('Publish image to GHCR') {
      when {
        allOf {
          expression { params.BUILD_IMAGE && params.PUBLISH_IMAGE }
          expression { isMainBranch() }
          expression { currentBuild.currentResult == 'SUCCESS' }
        }
      }
      steps {
        script {
          def commit = (env.GIT_COMMIT ?: 'unknown').take(12)
          def image = params.GHCR_IMAGE.trim().toLowerCase()
          withCredentials([usernamePassword(credentialsId: GHCR_CREDENTIALS_ID, usernameVariable: 'GHCR_USER', passwordVariable: 'GHCR_TOKEN')]) {
            // The token is read from the environment by the shell, never
            // interpolated into the command by Groovy.
            if (isUnix()) {
              sh 'echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin'
            } else {
              bat 'echo %GHCR_TOKEN%| docker login ghcr.io -u %GHCR_USER% --password-stdin'
            }
          }
          try {
            for (tag in ["sha-${commit}", "build-${env.BUILD_NUMBER}", 'latest']) {
              executeCommand("docker tag paypilot-server:${env.CI_TAG} ${image}:${tag}")
              executeCommand("docker push ${image}:${tag}")
            }
          } finally {
            executeCommand('docker logout ghcr.io')
          }
          env.PUBLISHED_IMAGE = "${image}:sha-${commit}"
          echo "Published ${env.PUBLISHED_IMAGE} (also tagged latest)."
        }
      }
    }

    stage('Deploy to Render') {
      when {
        allOf {
          expression { params.BUILD_IMAGE && params.PUBLISH_IMAGE && params.DEPLOY_TO_RENDER }
          expression { isMainBranch() }
          expression { currentBuild.currentResult == 'SUCCESS' }
        }
      }
      steps {
        timeout(time: 30, unit: 'MINUTES') {
          input(message: "Deploy ${env.PUBLISHED_IMAGE} to Render? Every check above passed.", ok: 'Deploy')
        }
        script {
          withCredentials([string(credentialsId: RENDER_HOOK_CREDENTIALS_ID, variable: 'RENDER_DEPLOY_HOOK')]) {
            if (isUnix()) {
              sh 'curl -fsS -X POST "$RENDER_DEPLOY_HOOK" > /dev/null'
            } else {
              bat 'curl.exe -fsS -X POST "%RENDER_DEPLOY_HOOK%" > NUL'
            }
          }
          echo 'Render deploy triggered. Waiting for the new version to answer (read-only checks).'
          sleep(time: 60, unit: 'SECONDS')
          retry(10) {
            sleep(time: 15, unit: 'SECONDS')
            executeCommand("node server/scripts/smoke-test.mjs ${params.PRODUCTION_API_URL} ${params.PRODUCTION_FRONTEND_ORIGIN}")
          }
        }
      }
    }
  }

  post {
    always {
      script {
        if (params.BUILD_IMAGE && env.CI_NAME) {
          // Best-effort cleanup of this build's containers, network, and images.
          def ignore = isUnix() ? ' || true' : ' || exit /b 0'
          executeCommand("docker rm -f ${env.CI_NAME}-api ${env.CI_NAME}-db${ignore}")
          executeCommand("docker network rm ${env.CI_NAME}${ignore}")
          executeCommand("docker image rm paypilot-server-build:${env.CI_TAG}${ignore}")
        }
      }
      archiveArtifacts artifacts: 'reports/**', allowEmptyArchive: true
    }
    success {
      echo 'All checks passed.'
    }
    unstable {
      echo 'Tests and builds passed, but the dependency audit needs attention (see the Dependency audit stage). Publish and Deploy were skipped.'
    }
    failure {
      echo 'The build failed. The failing stage is marked in red, and its message names the package and the command that failed.'
    }
  }
}
