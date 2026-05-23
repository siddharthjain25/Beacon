pipeline {
    agent any

    environment {
        APP_NAME = "beacon"
        IMAGE_BACKEND = "beacon-backend:latest"
    }

    options {
        timestamps()
        disableConcurrentBuilds()
    }

    stages {
        stage('Show Environment') {
            steps {
                sh '''
                    echo "Current Directory: $(pwd)"
                    echo "Files in root:"
                    ls -la
                    docker --version
                '''
            }
        }

        stage('Build Image') {
            steps {
                sh '''
                    echo "Building Docker image: ${IMAGE_BACKEND}..."
                    docker build -t ${IMAGE_BACKEND} .
                '''
            }
        }
    }

    post {
        success {
            echo "Successfully built ${IMAGE_BACKEND}"
        }
        always {
            sh 'docker images | grep ${APP_NAME} || true'
        }
    }
}
