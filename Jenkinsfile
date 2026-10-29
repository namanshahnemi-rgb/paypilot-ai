// Jenkins CI pipeline for PayPilot AI on a Windows agent.
//
// Installs, tests, lints, builds, and audits the repository's two npm
// packages, server/ and client/ (there is no root package.json). Nothing is
// deployed. No credentials are used and no .env file is read: the test suites
// mock PayPal and the local Ollama model, and only use 127.0.0.1.
//
// Agent requirements: Windows, Git, Node.js 22.18 or newer with npm (the
// client tests run TypeScript files directly with Node's built-in test
// runner; developed on Node 24.15), and access to the npm registry.

// Runs an npm command in one package folder. On failure, stops the build
// with a message naming the package, the command, and what to check.
def runNpm(String folder, String command, String hint) {
  dir(folder) {
    try {
      bat "npm ${command}"
    } catch (hudson.AbortException err) {
      error("[${folder}] 'npm ${command}' failed. ${hint}")
    }
  }
}

// Audits one package's dependencies with npm audit. Prints npm's report,
// saves the JSON report under reports/, and prints a one-line summary.
// High or critical findings, or an audit that cannot run, mark the build
// UNSTABLE rather than failing it, because nothing is deployed yet.
def auditDependencies(String folder) {
  def report = "reports\\npm-audit-${folder}.json"
  dir(folder) {
    echo "npm audit for ${folder}. A non-zero exit code in this step only means findings were reported."
    bat(returnStatus: true, script: 'npm audit')
    bat(returnStatus: true, script: "npm audit --json > ..\\${report}")
  }

  // Summarises the JSON report. Kept free of double quotes and backslashes
  // so it can be passed to node -e inside a bat command.
  def summarize = '''const fs=require('fs');const [file,pkg]=process.argv.slice(1);let r;try{r=JSON.parse(fs.readFileSync(file,'utf8'))}catch(e){console.log('npm audit for '+pkg+' produced no readable report.');console.log('AUDIT_RESULT=error');process.exit(0)}if(r.error){console.log('npm audit for '+pkg+' could not run: '+(r.error.code||'unknown error')+'.');console.log('AUDIT_RESULT=error');process.exit(0)}const v=(r.metadata&&r.metadata.vulnerabilities)||{};const n=k=>v[k]||0;const total=n('critical')+n('high')+n('moderate')+n('low')+n('info');console.log('npm audit summary for '+pkg+': critical='+n('critical')+', high='+n('high')+', moderate='+n('moderate')+', low='+n('low')+', info='+n('info')+' (total '+total+').');console.log('AUDIT_RESULT='+(n('critical')+n('high')>0?'high':total>0?'other':'clean'))'''
  def summary = bat(returnStdout: true, script: "@node -e \"${summarize}\" ${report} ${folder}").trim()
  echo summary

  if (summary.contains('AUDIT_RESULT=high')) {
    unstable("npm audit found high or critical vulnerabilities in ${folder}. See the report above and ${report}.")
  } else if (summary.contains('AUDIT_RESULT=error')) {
    unstable("npm audit could not check ${folder} (for example, the npm registry was unreachable), so its vulnerability status is unknown.")
  }
}

pipeline {
  agent any

  options {
    // The Checkout stage below checks out the job's configured SCM.
    skipDefaultCheckout()
    disableConcurrentBuilds()
    timeout(time: 30, unit: 'MINUTES')
    buildDiscarder(logRotator(numToKeepStr: '20'))
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
        checkout scm
        bat 'if exist reports rmdir /s /q reports'
        bat 'mkdir reports'
      }
    }

    stage('Check toolchain') {
      steps {
        bat 'node --version'
        bat 'npm --version'
        bat '''@node -e "const [a,b]=process.versions.node.split('.').map(Number);if(a<22||(a===22&&b<18)){console.error('Node.js '+process.versions.node+' is too old: PayPilot CI needs Node.js 22.18 or newer, because the client tests run TypeScript files directly with node --test.');process.exit(1)}"'''
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

    stage('Test') {
      steps {
        script {
          runNpm('server', 'test', 'A server test failed; the output above names it. The tests mock PayPal and Ollama, so no credentials or running services are needed. Reproduce with npm test in server/.')
          runNpm('client', 'test', 'A client test failed; the output above names it. Reproduce with npm test in client/.')
        }
      }
    }

    stage('Lint') {
      steps {
        script {
          runNpm('client', 'run lint', 'oxlint reported errors. Reproduce with npm run lint in client/.')
          echo 'server/ defines no lint script, so it is not linted.'
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
  }

  post {
    always {
      archiveArtifacts artifacts: 'reports/**', allowEmptyArchive: true
    }
    success {
      echo 'All checks passed. Nothing was deployed.'
    }
    unstable {
      echo 'Tests and builds passed, but the dependency audit needs attention (see the Dependency audit stage).'
    }
    failure {
      echo 'The build failed. The failing stage is marked in red, and its message names the package and the npm command that failed.'
    }
  }
}
